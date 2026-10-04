import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { clearServerInfo, HOST, readServerInfo, type ServerInfo } from "../server/serve";
import { homeDir, serverLogPath } from "../server/store";
import type { Health } from "../src/project/protocol";

export const DEFAULT_PORT = 4317;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function health(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json()) as Partial<Health>;
    return body.app === "littlesystem" ? (body as Health) : undefined;
  } catch {
    return undefined;
  }
}

/** The background server, if one is actually answering. */
export async function runningServer(): Promise<ServerInfo | undefined> {
  const info = readServerInfo();
  if (!info) return undefined;
  const h = await health(info.port);
  if (h && h.pid === info.pid) return info;
  clearServerInfo(info.pid);
  return undefined;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port++) if (await portFree(port)) return port;
  throw new Error(`no free port between ${start} and ${start + 49}`);
}

/** Starts `littlesystem serve` detached from this terminal and waits until it answers. */
export async function startDaemon(cliFile: string, preferredPort: number): Promise<ServerInfo> {
  const port = await findPort(preferredPort);
  fs.mkdirSync(homeDir(), { recursive: true });
  const log = fs.openSync(serverLogPath(), "a");
  const child = spawn(process.execPath, [cliFile, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);

  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const info = readServerInfo();
    if (info && info.pid === child.pid && (await health(port))) return info;
    if (child.exitCode !== null) break;
  }
  throw new Error(`the server didn't start; see ${serverLogPath()}`);
}

export async function stopDaemon(info: ServerInfo): Promise<void> {
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 30; i++) {
    if (!(await health(info.port))) break;
    await sleep(100);
  }
  clearServerInfo(info.pid);
}

export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
