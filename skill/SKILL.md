---
name: littlesystem
description: Design and simulate software systems on a live littlesystem canvas (services, databases, queues, crons and clickable UI screens wired together) through the `littlesystem` CLI. Use when the user mentions littlesystem, wants to sketch or prototype a system architecture, model how messages flow between services, or build/edit nodes, wires or UI frames in a littlesystem project.
---

# littlesystem

A littlesystem project is a canvas of **nodes** joined by **wires**. Every node runs a small JavaScript handler when a message arrives; `ui` nodes also render a live React screen. The browser app simulates message flow in real time. You edit projects with the `littlesystem` CLI; the open browser tab updates instantly.

## Workflow

1. Find the project: `littlesystem project list` (`*` marks the current one). Commands apply to the project in the nearest `./littlesystem/` folder, else the current one; override with `-p <slug>`.
2. Inspect before changing: `littlesystem project show` (nodes, wires, file path) and `littlesystem node show <name>` (full code).
3. Make changes with `node add|edit|remove` and `wire add|remove`. Pass multi-line code through stdin with `--code -` (or `--view -`) and a quoted heredoc.
4. Run `littlesystem check` to compile every handler and view.
5. `littlesystem start` launches the app in the background and prints the URL; tell the user to open it and press Play.

The project file (`littlesystem project path`) is plain JSON and can be edited directly, but the CLI validates input and is less error-prone.

## Commands

```bash
littlesystem project new "Coffee shop online" [--here | --global] [--template shop]
littlesystem project list | show | path | use <slug> | remove <slug>
littlesystem node add <name> --kind service|db|queue|cron|ui [--code -] [--view -] [--to a,b] [--from c] [--x 0 --y 0 --w 220 --h 130]
littlesystem node edit <name> [--name new] [--kind k] [--code -] [--view -] [--x --y --w --h]
littlesystem node show <name> | node list | node remove <name>
littlesystem wire add <from> <to> | wire remove <from> <to> | wire list
littlesystem check
littlesystem start [--no-open] | status | stop
```

Example:

```bash
littlesystem node add api --kind service --from shop-ui --to orders-db --code - <<'EOF'
const p = msg.payload;
if (p.type === "createOrder") {
  ctx.send("orders-db", { op: "insert", table: "orders", row: { id: p.id, item: p.item } });
}
if (p.type === "inserted") ctx.send("shop-ui", { type: "orderCreated", id: p.row.id });
EOF
```

Omit `--code` to start from the kind's default handler, which is a good template. Positions are optional; new nodes are placed to the right of the existing ones.

## Handlers

The handler body runs as `function (msg, ctx) { ... }` for every message delivered to the node.

- `msg.payload`: whatever the sender sent (any JSON value); `msg.from`: sender node name.
- `ctx.state`: this node's persistent, mutable state object. Mutate it in place.
- `ctx.send(to, payload, { latency? })`: send to a node by name. **Requires a wire between the two nodes** (either direction); otherwise an error is logged ("no wire between …").
- `ctx.reply(msg, payload)`: send back to the sender. `ctx.forward(payload)`: send to every node this one has an outgoing wire to (`ctx.out` lists them).
- `ctx.after(ms, payload)`: deliver `payload` to this node later; such messages have `msg.from === ctx.self`.
- `ctx.now` (simulated ms), `ctx.rand()` (seeded random), `ctx.log(...)` (shows in the event log), `ctx.self` (own name).

Messages take about 700 ms of simulated time to travel. Handlers are synchronous: no `await`, `fetch` or timers; use `ctx.after` for anything that happens later.

## Node kinds

- `service`: plain logic. Default: counts messages and forwards them.
- `db`: tiny table store. Default handler accepts `{ op: "insert", table, row }` (replies `{ type: "inserted", table, row }`), `{ op: "update", table, id, patch }` and `{ op: "list", table }` (replies `{ type: "rows", table, rows }`). State is `{ [table]: rows[] }` and the canvas renders the tables.
- `queue`: buffers incoming payloads in `ctx.state.items` and forwards one every 1.5 s to its outgoing wires.
- `cron`: receives `"start"` once when the simulation starts. Reschedule itself with `ctx.after(EVERY, "tick")` on every self-message, and do the periodic work when `msg.payload !== "start"`.
- `ui`: a screen. The handler receives messages sent to the UI; `--view` holds the screen's JSX.

## UI views

A view is JSX source that defines `function View({ state, query, send })`:

- `state`: this ui node's state (set by its handler).
- `query(name)`: read any node's state, e.g. `query("orders-db")?.orders ?? []`.
- `send(to, payload)`: send a message from this ui node (needs a wire too).

`React` is in scope (`React.useState` works); no imports. Built-in classes: `col`, `row`, `between`, `muted`, `btn`, `chip` (+ `on`), `card`, `badge`, `toast`, `stat`, and `h3`/`h4` styling.

```jsx
function View({ state, query, send }) {
  const orders = query("orders-db")?.orders ?? [];
  return (
    <div className="col">
      <h3>Shop</h3>
      <button className="btn" onClick={() => send("api", { type: "createOrder", item: "Coffee" })}>Buy</button>
      {orders.map((o) => <div key={o.id} className="card">{o.item}</div>)}
    </div>
  );
}
```

## Tips

- Name nodes in kebab-case (`orders-db`, `email-queue`); handlers address each other by name.
- Payloads conventionally carry a `type` (or `op` for dbs); the canvas labels moving messages with it.
- For a reference system, run `littlesystem project new "Demo" --template shop`, then `littlesystem project show -p demo`.
