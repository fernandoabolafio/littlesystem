import fs from "node:fs";
import http from "node:http";
import { createApi } from "./api";
import { serverInfoPath, writeFileAtomic } from "./store";

export interface ServerInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export const HOST = "127.0.0.1";

export function readServerInfo(): ServerInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(serverInfoPath(), "utf8")) as ServerInfo;
  } catch {
    return undefined;
  }
}

export function clearServerInfo(pid: number) {
  if (readServerInfo()?.pid === pid) fs.rmSync(serverInfoPath(), { force: true });
}

/** Runs the API + built app in this process until it gets SIGINT/SIGTERM. */
export function serve(opts: { port: number; appDir: string; version: string }): Promise<http.Server> {
  if (!fs.existsSync(opts.appDir)) {
    throw new Error(`app build not found at ${opts.appDir} (run \`pnpm build\`)`);
  }
  const api = createApi({ version: opts.version, appDir: opts.appDir });
  const server = http.createServer((req, res) => api.handle(req, res));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, HOST, () => {
      const info: ServerInfo = {
        pid: process.pid,
        port: opts.port,
        version: opts.version,
        startedAt: new Date().toISOString(),
      };
      writeFileAtomic(serverInfoPath(), JSON.stringify(info, null, 2) + "\n");
      const shutdown = () => {
        clearServerInfo(process.pid);
        api.close();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      resolve(server);
    });
  });
}
