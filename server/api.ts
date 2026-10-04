import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { parseProject, ProjectError } from "../src/project/format";
import type { Health, ProjectInfo, ServerEvent } from "../src/project/protocol";
import {
  createProject,
  getEntry,
  globalProjectsDir,
  listProjects,
  registryPath,
  saveProject,
  unregisterProject,
  type ProjectRecord,
} from "./store";

const MAX_BODY = 5 * 1024 * 1024;
const WATCH_INTERVAL = 250;

const toInfo = (r: ProjectRecord): ProjectInfo => ({
  slug: r.slug,
  path: r.path,
  name: r.project?.name ?? r.slug,
  ...(r.text !== undefined && !r.error ? { text: r.text } : {}),
  ...(r.error ? { error: r.error } : {}),
});
const fingerprint = (p: ProjectInfo) => p.text ?? `error:${p.error}`;

/** Watches the registry and every project file, and streams changes to connected browsers. */
class Hub {
  private clients = new Set<http.ServerResponse>();
  private known = new Map<string, string>();
  private watched = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private keepAlive: NodeJS.Timeout | undefined;

  connect(res: http.ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const projects = this.refresh();
    this.write(res, { type: "snapshot", projects });
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stop();
    });
    this.keepAlive ??= setInterval(() => {
      for (const c of this.clients) c.write(": ping\n\n");
    }, 25_000);
  }

  /** Re-reads everything; broadcasts what changed. Debounced when triggered by file watchers. */
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 40);
  }

  refresh(): ProjectInfo[] {
    const projects = listProjects().map(toInfo);
    const seen = new Set<string>();
    for (const p of projects) {
      seen.add(p.slug);
      const fp = fingerprint(p);
      if (this.known.get(p.slug) === fp) continue;
      this.known.set(p.slug, fp);
      this.broadcast({ type: "project", project: p });
    }
    for (const slug of [...this.known.keys()]) {
      if (seen.has(slug)) continue;
      this.known.delete(slug);
      this.broadcast({ type: "removed", slug });
    }
    this.watch([registryPath(), ...projects.map((p) => p.path)]);
    return projects;
  }

  private watch(files: string[]) {
    const wanted = new Set(files);
    for (const f of this.watched) {
      if (wanted.has(f)) continue;
      fs.unwatchFile(f);
      this.watched.delete(f);
    }
    for (const f of wanted) {
      if (this.watched.has(f)) continue;
      fs.watchFile(f, { interval: WATCH_INTERVAL }, () => this.schedule());
      this.watched.add(f);
    }
  }

  private stop() {
    for (const f of this.watched) fs.unwatchFile(f);
    this.watched.clear();
    this.known.clear();
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
  }

  close() {
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.stop();
  }

  private broadcast(event: ServerEvent) {
    for (const c of this.clients) this.write(c, event);
  }

  private write(res: http.ServerResponse, event: ServerEvent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * The API writes files on this machine, so only answer requests addressed to a loopback host.
 * This blocks DNS-rebinding pages; cross-origin writes are already blocked by CORS preflight.
 */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function serveStatic(appDir: string, urlPath: string, res: http.ServerResponse) {
  const root = path.resolve(appDir);
  let file = path.resolve(root, "." + decodeURIComponent(urlPath));
  if (!file.startsWith(root)) throw new HttpError(403, "forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(urlPath)) throw new HttpError(404, "not found");
    file = path.join(root, "index.html");
  }
  const immutable = urlPath.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

export interface ApiOptions {
  version: string;
  /** Built app to serve for non-API paths. Omit when something else (vite) serves the app. */
  appDir?: string;
}

export function createApi(opts: ApiOptions) {
  const hub = new Hub();

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] !== "api") {
      if (!opts.appDir || (method !== "GET" && method !== "HEAD")) return false;
      serveStatic(opts.appDir, url.pathname, res);
      return true;
    }

    if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, "littlesystem only answers on localhost");

    if (parts[1] === "health" && method === "GET") {
      const health: Health = { app: "littlesystem", version: opts.version, pid: process.pid };
      sendJson(res, 200, health);
      return true;
    }
    if (parts[1] === "events" && method === "GET") {
      hub.connect(res);
      return true;
    }
    if (parts[1] === "projects" && parts.length === 2 && method === "GET") {
      sendJson(res, 200, listProjects().map(toInfo));
      return true;
    }
    if (parts[1] === "projects" && parts.length === 2 && method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; near?: unknown };
      if (typeof body.name !== "string" || !body.name.trim()) throw new HttpError(400, "name is required");
      const near = typeof body.near === "string" ? getEntry(body.near) : undefined;
      const dir = near ? path.dirname(near.path) : globalProjectsDir();
      const entry = createProject({ name: body.name.trim(), dir });
      hub.refresh();
      sendJson(res, 201, entry);
      return true;
    }
    if (parts[1] === "projects" && parts.length === 3) {
      const slug = decodeURIComponent(parts[2]!);
      const entry = getEntry(slug);
      if (!entry) throw new HttpError(404, `no project "${slug}"`);
      if (method === "PUT") {
        const project = parseProject(await readJson(req));
        const text = saveProject(entry, project);
        hub.refresh();
        sendJson(res, 200, { text });
        return true;
      }
      if (method === "DELETE") {
        unregisterProject(slug);
        hub.refresh();
        sendJson(res, 200, { removed: slug, path: entry.path });
        return true;
      }
    }
    throw new HttpError(404, "not found");
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse, next?: () => void) {
    route(req, res)
      .then((handled) => {
        if (handled) return;
        if (next) return next();
        sendJson(res, 404, { error: "not found" });
      })
      .catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : e instanceof ProjectError ? 400 : 500;
        if (status === 500) console.error(e);
        if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
        else res.end();
      });
  }

  return { handle, close: () => hub.close() };
}
