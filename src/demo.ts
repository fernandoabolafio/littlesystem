import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import { DEFAULT_CODE, DEFAULT_SIZE } from "./sim/defaults";
import { engine } from "./sim/runtime";
import type { NodeKind } from "./sim/engine";
import { SYS_TYPE } from "./shapes/sysType";

const SHOP_VIEW = `function View({ state, query, send }) {
  const [item, setItem] = React.useState("Coffee");
  const orders = query("orders-db")?.orders ?? [];
  return (
    <div className="col">
      <h3>☕ Little Shop</h3>
      <div className="row">
        {["Coffee", "Bagel", "Tea"].map((p) => (
          <button key={p} className={"chip" + (p === item ? " on" : "")} onClick={() => setItem(p)}>
            {p}
          </button>
        ))}
      </div>
      <button className="btn" onClick={() => send("api", { type: "createOrder", item })}>
        Buy {item}
      </button>
      {state.toast && <div className="toast">{state.toast}</div>}
      <h4>Your orders</h4>
      {orders.length === 0 && <div className="muted">No orders yet</div>}
      {orders.slice().reverse().map((o) => (
        <div key={o.id} className="card row between">
          <span>{o.item} <span className="muted">#{o.id}</span></span>
          <span className={"badge " + o.status}>{o.status}</span>
        </div>
      ))}
    </div>
  );
}`;

const SHOP_CODE = `if (msg.payload.type === "orderCreated") {
  ctx.state.toast = "Order #" + msg.payload.id + " placed";
}`;

const API_CODE = `const p = msg.payload;
ctx.state.pending ??= {};

if (p.type === "createOrder") {
  const id = String(Math.floor(ctx.rand() * 9000 + 1000));
  ctx.state.pending[id] = msg.from;
  ctx.send("orders-db", {
    op: "insert",
    table: "orders",
    row: { id, item: p.item, status: "placed" },
  });
}

if (p.type === "inserted") {
  const id = p.row.id;
  ctx.send(ctx.state.pending[id], { type: "orderCreated", id });
  delete ctx.state.pending[id];
  ctx.send("email-queue", { type: "sendReceipt", orderId: id });
}`;

const MAILER_CODE = `if (msg.payload.type === "sendReceipt") {
  ctx.state.sent = (ctx.state.sent ?? 0) + 1;
  ctx.send("orders-db", {
    op: "update",
    table: "orders",
    id: msg.payload.orderId,
    patch: { status: "emailed" },
  });
}`;

const REPORT_CODE = `// Every 8s of simulated time: pull all orders and summarize them.
const EVERY = 8000;
if (msg.from === ctx.self) {
  ctx.after(EVERY, "tick");
  if (msg.payload === "start") return;
  ctx.send("orders-db", { op: "list", table: "orders" });
  return;
}
if (msg.payload.type === "rows") {
  const rows = msg.payload.rows;
  ctx.state.lastReport = {
    atSecond: Math.round(ctx.now / 1000),
    orders: rows.length,
    stuck: rows.filter((r) => r.status !== "emailed").length,
  };
}`;

const OPS_VIEW = `function View({ query }) {
  const orders = query("orders-db")?.orders ?? [];
  const backlog = query("email-queue")?.items?.length ?? 0;
  const emailed = orders.filter((o) => o.status === "emailed").length;
  const report = query("nightly-report")?.lastReport;
  return (
    <div className="col">
      <h3>Ops dashboard</h3>
      <div className="row">
        <div className="stat"><b>{orders.length}</b><span>orders</span></div>
        <div className="stat"><b>{backlog}</b><span>email backlog</span></div>
        <div className="stat"><b>{emailed}</b><span>emailed</span></div>
      </div>
      <div className="card">
        {report
          ? <>⏱ Report @ {report.atSecond}s: {report.orders} orders, {report.stuck} not emailed</>
          : <span className="muted">⏱ Waiting for first nightly report…</span>}
      </div>
    </div>
  );
}`;

interface NodeSpec {
  key: string;
  kind: NodeKind;
  name: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  code?: string;
  view?: string;
}

const NODES: NodeSpec[] = [
  { key: "shop", kind: "ui", name: "shop-ui", x: 0, y: 0, h: 420, code: SHOP_CODE, view: SHOP_VIEW },
  { key: "api", kind: "service", name: "api", x: 420, y: 150, code: API_CODE },
  { key: "db", kind: "db", name: "orders-db", x: 780, y: 0, w: 280, h: 210 },
  { key: "queue", kind: "queue", name: "email-queue", x: 780, y: 330 },
  { key: "mailer", kind: "service", name: "mailer", x: 1150, y: 320, code: MAILER_CODE },
  { key: "ops", kind: "ui", name: "ops-ui", x: 1150, y: -10, w: 320, h: 240, view: OPS_VIEW },
  { key: "report", kind: "cron", name: "nightly-report", x: 400, y: -150, w: 260, h: 150, code: REPORT_CODE },
];

const WIRES: [string, string][] = [
  ["shop", "api"],
  ["api", "db"],
  ["api", "queue"],
  ["queue", "mailer"],
  ["mailer", "db"],
  ["report", "db"],
];

export function connect(editor: Editor, from: TLShapeId, to: TLShapeId) {
  const id = createShapeId();
  editor.createShape({ id, type: "arrow", x: 0, y: 0 });
  const anchor = { normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false };
  editor.createBindings([
    { type: "arrow", fromId: id, toId: from, props: { terminal: "start", ...anchor } },
    { type: "arrow", fromId: id, toId: to, props: { terminal: "end", ...anchor } },
  ]);
}

export function loadDemo(editor: Editor) {
  editor.run(() => {
    editor.deleteShapes([...editor.getCurrentPageShapeIds()]);
    const ids = new Map<string, TLShapeId>();
    for (const n of NODES) {
      const id = createShapeId();
      ids.set(n.key, id);
      editor.createShape({
        id,
        type: SYS_TYPE,
        x: n.x,
        y: n.y,
        props: {
          ...DEFAULT_SIZE[n.kind],
          ...(n.w ? { w: n.w } : {}),
          ...(n.h ? { h: n.h } : {}),
          kind: n.kind,
          name: n.name,
          code: n.code ?? DEFAULT_CODE[n.kind],
          ...(n.view ? { view: n.view } : {}),
        },
      });
    }
    for (const [a, b] of WIRES) connect(editor, ids.get(a)!, ids.get(b)!);
  });
  engine.reset();
  editor.zoomToFit({ animation: { duration: 300 } });
}
