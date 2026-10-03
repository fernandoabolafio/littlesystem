import type { NodeKind } from "./engine";

export const DEFAULT_SIZE: Record<NodeKind, { w: number; h: number }> = {
  service: { w: 220, h: 130 },
  db: { w: 230, h: 190 },
  queue: { w: 220, h: 110 },
  cron: { w: 220, h: 110 },
  ui: { w: 300, h: 380 },
};

export const DEFAULT_CODE: Record<NodeKind, string> = {
  service: `// msg = { from, payload }   ctx = { state, send, reply, forward, after, log, now, out }
ctx.state.seen = (ctx.state.seen ?? 0) + 1;
ctx.forward(msg.payload);`,

  db: `// A tiny table store: { op: "insert" | "update" | "list", table, row?, id?, patch? }
const p = msg.payload;
const table = (ctx.state[p.table] ??= []);
switch (p.op) {
  case "insert":
    table.push(p.row);
    ctx.reply(msg, { type: "inserted", table: p.table, row: p.row });
    break;
  case "update": {
    const row = table.find((r) => r.id === p.id);
    if (row) Object.assign(row, p.patch);
    break;
  }
  case "list":
    ctx.reply(msg, { type: "rows", table: p.table, rows: table });
    break;
}`,

  queue: `// Buffers messages and drains one every 1.5s to everything downstream.
ctx.state.items ??= [];
if (msg.from === ctx.self) {
  const next = ctx.state.items.shift();
  if (next) ctx.forward(next);
  ctx.state.draining = ctx.state.items.length > 0;
  if (ctx.state.draining) ctx.after(1500, "drain");
  return;
}
ctx.state.items.push(msg.payload);
if (!ctx.state.draining) {
  ctx.state.draining = true;
  ctx.after(1500, "drain");
}`,

  cron: `// Wakes up every EVERY ms of simulated time (msg.from === ctx.self on each run).
const EVERY = 5000;
if (msg.from === ctx.self) {
  ctx.after(EVERY, "tick");
  if (msg.payload === "start") return;
  ctx.state.runs = (ctx.state.runs ?? 0) + 1;
  ctx.forward({ type: "tick", at: ctx.now });
}`,

  ui: `// UI frames are nodes too: this handles messages sent back to the UI.
ctx.state.inbox = [msg.payload, ...(ctx.state.inbox ?? [])].slice(0, 5);`,
};

export const DEFAULT_VIEW = `// props: state (this node), query(name) (any node's state), send(to, payload)
function View({ state, query, send }) {
  return (
    <div className="col">
      <h3>New screen</h3>
      <button className="btn" onClick={() => send("api", { type: "ping" })}>
        Send ping
      </button>
      <pre className="muted">{JSON.stringify(state, null, 2)}</pre>
    </div>
  );
}`;
