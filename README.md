# littlesystem

Sketch a software system on a canvas (services, databases, queues, crons and clickable UI screens) and watch it run. Every node is a few lines of JavaScript; messages visibly travel along the wires.

Drive it by hand in the browser, from the CLI, or let your coding agent build it for you.

## Get going

```bash
npm i -g littlesystem

littlesystem project new "Coffee shop online"   # asks where to keep it
littlesystem start                              # opens http://localhost:4317
```

The first `project new` offers to install a skill for your coding agent (Cursor, Claude Code, Codex, …), so you can just ask it: *"add an api that writes orders to a db and emails a receipt through a queue"*.

Want something to poke at first? `littlesystem project new "Demo" --template shop`.

## Projects

A project is one JSON file. You choose where it lives:

- `./littlesystem/<name>.json`, next to your code, so it's versioned with the repo; or
- `~/.littlesystem/projects/<name>.json`, just on your machine.

Each project is a page in the app (use tldraw's page menu to switch, rename or add). Edits flow both ways: what you change on the canvas is written to the file, and what the CLI, your agent or your editor writes to the file shows up on the canvas immediately.

Commands pick their project like git picks a repo: the nearest `./littlesystem/` folder, else the current project (`littlesystem project use <slug>`), or explicitly with `-p <slug>`.

## CLI

```bash
littlesystem project new|list|show|path|use|add|remove
littlesystem node add api --kind service --from shop-ui --to orders-db --code - <<'EOF'
if (msg.payload.type === "createOrder") ctx.send("orders-db", { op: "insert", table: "orders", row: msg.payload });
EOF
littlesystem node edit|show|list|remove
littlesystem wire add|remove|list
littlesystem check                 # compile everything, flag sends to unwired nodes
littlesystem start|status|stop     # background app on localhost
littlesystem skill install --for cursor,claude,codex [--project]
```

`littlesystem help` has the details. The skill ([skill/SKILL.md](skill/SKILL.md)) documents the handler API (`msg`, `ctx.send`, `ctx.state`, `ctx.after`, …) and how UI views work.

## Develop

```bash
pnpm i
pnpm dev          # the app with the same local API, editing your real projects
pnpm build        # dist/app (the canvas) + dist/cli.js (the CLI)
pnpm cli help     # run the built CLI
```

Without the local API (for example, a static deploy of `dist/app`), the app falls back to keeping everything in the browser.

## License

littlesystem's own code: _license to be chosen_.

The canvas is built on the [tldraw SDK](https://tldraw.dev), which has its own license ([licenses/tldraw-LICENSE.md](licenses/tldraw-LICENSE.md)). It is not open source: production use requires a tldraw license key. Pass one at build time with `VITE_TLDRAW_LICENSE_KEY`.
