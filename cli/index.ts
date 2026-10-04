import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { serve } from "../server/serve";
import {
  createProject,
  findLocalProjectFiles,
  getEntry,
  globalProjectsDir,
  listProjects,
  LOCAL_DIR,
  readProjectFile,
  readRegistry,
  registerProject,
  resolveProject,
  saveProject,
  unregisterProject,
  updateRegistry,
  type RegistryEntry,
} from "../server/store";
import { demoProject } from "../src/project/demo";
import {
  addNode,
  addWire,
  getNode,
  isNodeKind,
  NODE_KINDS,
  ProjectError,
  removeNode,
  removeWire,
  updateNode,
  type NodeInput,
  type Project,
} from "../src/project/format";
import { nodeErrors, nodeWarnings } from "./check";
import { DEFAULT_PORT, openBrowser, runningServer, startDaemon, stopDaemon } from "./daemon";
import { choose, closePrompt, interactive } from "./prompt";
import { harnessById, HARNESSES, installSkill, installSkillInto, offerSkill, SKILL } from "./skill";

const VERSION = pkg.version;
const CLI_FILE = fileURLToPath(import.meta.url);
const APP_DIR = path.join(path.dirname(CLI_FILE), "app");
const TEMPLATES = ["blank", "shop"] as const;

class UsageError extends Error {}

const HELP = `littlesystem ${VERSION}: sketch systems that actually run.

Usage: littlesystem <command> [options]

Projects
  project new <name>          Create a project (asks where; --here: ./${LOCAL_DIR}/, --global: ~/.littlesystem/projects)
                              [--dir <path>] [--template blank|shop] [-y]
  project list                List projects (* = current)
  project show                Nodes, wires and file of a project [--json for the raw file]
  project path                Print the project file's path
  project use <slug>          Make a project the current one
  project add <file.json>     Register an existing project file
  project remove <slug>       Forget a project [--delete to also delete its file]

Nodes and wires
  node list                   List nodes
  node show <name>            Print a node's handler (and view) [--json]
  node add <name> --kind <k>  Add a node; kinds: ${NODE_KINDS.join(", ")}
       [--code <js> | --code-file <f> | --code -]   handler (- reads stdin)
       [--view <jsx> | --view-file <f> | --view -]  ui nodes only
       [--to a,b] [--from c]                        wire it up
       [--x n --y n --w n --h n]                    position/size (default: auto)
  node edit <name>            Same options as add, plus --name <new>
  node remove <name>          Remove a node and its wires
  wire add <from> <to>        Connect two nodes
  wire remove <from> <to>     Disconnect two nodes
  wire list                   List wires
  check                       Compile every handler/view and flag sends to unwired nodes

App
  start                       Start the app in the background and open it [--port n] [--no-open]
  status                      Is it running, and where
  stop                        Stop the background app
  serve                       Run the app in the foreground [--port n]

Setup
  init                        Install the agent skill (Cursor, Claude Code, Codex, …)
  skill install               [--for ${HARNESSES.map((h) => h.id).join(",")}] [--project] [--dir <path>]
  skill show                  Print the skill (to paste into AGENTS.md, etc.)

Most commands take -p <slug> to pick a project. Without it they use the project in the
nearest ./${LOCAL_DIR}/ folder, else the current one.`;

type Options = NonNullable<ParseArgsConfig["options"]>;

/** `--y -200` → `--y=-200`: node's parser would otherwise read `-200` as a flag. */
function joinNegativeNumbers(args: string[], options: Options): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const name = arg.startsWith("--") ? arg.slice(2) : undefined;
    if (name && options[name]?.type === "string" && next !== undefined && /^-\d/.test(next)) {
      out.push(`${arg}=${next}`);
      i++;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({
      args: joinNegativeNumbers(args, options),
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

const PROJECT_OPT = { project: { type: "string", short: "p" } } as const;
const NODE_OPTS = {
  ...PROJECT_OPT,
  kind: { type: "string", short: "k" },
  name: { type: "string" },
  code: { type: "string" },
  "code-file": { type: "string" },
  view: { type: "string" },
  "view-file": { type: "string" },
  to: { type: "string" },
  from: { type: "string" },
  x: { type: "string" },
  y: { type: "string" },
  w: { type: "string" },
  h: { type: "string" },
  force: { type: "boolean" },
} as const;

// ---------------------------------------------------------------------------------------------
// helpers

function pretty(file: string): string {
  const rel = path.relative(process.cwd(), file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `./${rel}`;
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

const appUrl = (port: number, slug?: string) =>
  `http://localhost:${port}/${slug ? `?p=${encodeURIComponent(slug)}` : ""}`;

let stdinUsed = false;
async function readStdin(): Promise<string> {
  if (stdinUsed) throw new UsageError("only one of --code/--view can read from stdin (-)");
  stdinUsed = true;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
}

async function readSource(inline: string | undefined, file: string | undefined, flag: string) {
  if (inline !== undefined && file !== undefined) throw new UsageError(`use --${flag} or --${flag}-file, not both`);
  if (file !== undefined) return fs.readFileSync(file, "utf8").replace(/\n$/, "");
  if (inline === "-") return readStdin();
  return inline;
}

function num(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${flag} must be a number`);
  return n;
}

const list = (value: string | undefined) =>
  value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

function load(projectFlag: string | undefined) {
  const entry = resolveProject(process.cwd(), projectFlag);
  return { entry, project: readProjectFile(entry.path).project };
}

function save(entry: RegistryEntry, project: Project, message: string) {
  saveProject(entry, project);
  console.log(`${message} (${entry.slug})`);
}

function reportProblems(project: Project, names: string[], force: boolean) {
  for (const name of names) {
    const node = getNode(project, name);
    const errors = nodeErrors(node);
    if (errors.length && !force) {
      throw new ProjectError(`node "${name}" doesn't compile:\n  ${errors.join("\n  ")}\n(pass --force to save it anyway)`);
    }
    for (const w of [...errors, ...nodeWarnings(project, node)]) console.warn(`warning: ${name} ${w}`);
  }
}

// ---------------------------------------------------------------------------------------------
// project

async function projectNew(args: string[]) {
  const { values, positionals } = parse(args, {
    here: { type: "boolean" },
    global: { type: "boolean" },
    dir: { type: "string" },
    template: { type: "string", short: "t" },
    yes: { type: "boolean", short: "y" },
  });
  const name = positionals.join(" ").trim();
  if (!name) throw new UsageError('give the project a name: littlesystem project new "Coffee shop online"');
  const template = values.template ?? "blank";
  if (!(TEMPLATES as readonly string[]).includes(template)) {
    throw new UsageError(`--template must be one of ${TEMPLATES.join(", ")}`);
  }

  const localDir = path.join(process.cwd(), LOCAL_DIR);
  let dir: string;
  if (values.dir) dir = path.resolve(values.dir);
  else if (values.global) dir = globalProjectsDir();
  else if (values.here || values.yes || !interactive()) dir = localDir;
  else {
    const i = await choose(`Where should "${name}" live?`, [
      `${pretty(localDir)}/  (next to your code, commit it with the repo)`,
      `${pretty(globalProjectsDir())}/  (just on this machine)`,
    ]);
    dir = i === 0 ? localDir : globalProjectsDir();
  }

  const firstRun = !readRegistry().skillOffered;
  const entry = createProject({ name, dir, project: template === "shop" ? demoProject(name) : undefined });
  updateRegistry((r) => {
    r.current = entry.slug;
  });
  console.log(`Created "${name}" at ${pretty(entry.path)} (slug: ${entry.slug})`);
  const local = findLocalProjectFiles(process.cwd());
  if (local.length && !local.includes(entry.path)) {
    console.log(`Note: commands run here still default to ${pretty(local[0]!)}; add -p ${entry.slug} to target this one.`);
  }

  if (firstRun && !values.yes && interactive()) {
    console.log();
    for (const file of await offerSkill()) console.log(`Installed skill: ${pretty(file)}`);
    updateRegistry((r) => {
      r.skillOffered = true;
    });
  }

  const server = await runningServer();
  console.log();
  if (server) console.log(`It's live at ${appUrl(server.port, entry.slug)}`);
  else console.log(`Next: littlesystem start          # opens the canvas`);
  console.log(`      littlesystem node add api --kind service`);
}

function projectList(args: string[]) {
  const { values } = parse(args, { json: { type: "boolean" } });
  const records = listProjects();
  const current = readRegistry().current;
  if (values.json) {
    console.log(JSON.stringify(records.map(({ slug, path: p, project, error }) => ({
      slug,
      path: p,
      name: project?.name,
      nodes: project?.nodes.length,
      current: slug === current,
      ...(error ? { error } : {}),
    })), null, 2));
    return;
  }
  if (!records.length) {
    console.log('No projects yet. Create one with: littlesystem project new "My system"');
    return;
  }
  const width = Math.max(...records.map((r) => r.slug.length));
  for (const r of records) {
    const mark = r.slug === current ? "*" : " ";
    const count = r.project?.nodes.length;
    const detail = r.project ? `${r.project.name} (${count} node${count === 1 ? "" : "s"})` : `error: ${r.error}`;
    console.log(`${mark} ${r.slug.padEnd(width)}  ${detail}  ${pretty(r.path)}`);
  }
}

function printNodes(project: Project) {
  if (!project.nodes.length) {
    console.log("  (no nodes yet: littlesystem node add <name> --kind service)");
    return;
  }
  const width = Math.max(...project.nodes.map((n) => n.name.length));
  for (const n of [...project.nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const lines = n.code.split("\n").length;
    console.log(`  ${n.name.padEnd(width)}  ${n.kind.padEnd(7)}  at ${n.x},${n.y}  ${lines} lines${n.kind === "ui" ? " + view" : ""}`);
  }
}

function printWires(project: Project) {
  if (!project.wires.length) console.log("  (no wires)");
  for (const [a, b] of project.wires) console.log(`  ${a} → ${b}`);
}

function projectShow(args: string[]) {
  const { values } = parse(args, { ...PROJECT_OPT, json: { type: "boolean" } });
  const { entry, project } = load(values.project);
  if (values.json) {
    process.stdout.write(fs.readFileSync(entry.path, "utf8"));
    return;
  }
  console.log(`${project.name} (${entry.slug})\nfile: ${pretty(entry.path)}\n\nnodes:`);
  printNodes(project);
  console.log("\nwires:");
  printWires(project);
}

function projectUse(args: string[]) {
  const { positionals } = parse(args, {});
  const slug = need(positionals[0], "project slug");
  if (!getEntry(slug)) throw new ProjectError(`no project "${slug}". See \`littlesystem project list\`.`);
  updateRegistry((r) => {
    r.current = slug;
  });
  console.log(`Current project: ${slug}`);
}

function projectAdd(args: string[]) {
  const { positionals } = parse(args, {});
  const file = path.resolve(need(positionals[0], "path to a project .json file"));
  readProjectFile(file);
  const entry = registerProject(file);
  console.log(`Registered ${pretty(file)} as "${entry.slug}"`);
}

function projectRemove(args: string[]) {
  const { values, positionals } = parse(args, { delete: { type: "boolean" } });
  const slug = need(positionals[0], "project slug");
  const entry = unregisterProject(slug);
  if (!entry) throw new ProjectError(`no project "${slug}"`);
  if (values.delete) {
    fs.rmSync(entry.path, { force: true });
    console.log(`Removed "${slug}" and deleted ${pretty(entry.path)}`);
  } else {
    console.log(`Removed "${slug}" from the list; its file is still at ${pretty(entry.path)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// nodes and wires

async function nodeInput(values: ReturnType<typeof parse<typeof NODE_OPTS>>["values"]) {
  if (values.kind !== undefined && !isNodeKind(values.kind)) {
    throw new UsageError(`--kind must be one of ${NODE_KINDS.join(", ")}`);
  }
  const input: Partial<NodeInput> = {
    kind: values.kind,
    name: values.name,
    code: await readSource(values.code, values["code-file"], "code"),
    view: await readSource(values.view, values["view-file"], "view"),
    x: num(values.x, "x"),
    y: num(values.y, "y"),
    w: num(values.w, "w"),
    h: num(values.h, "h"),
  };
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<NodeInput>;
}

function wireUp(project: Project, name: string, to: string[], from: string[]) {
  let next = project;
  for (const t of to) next = addWire(next, name, t);
  for (const f of from) next = addWire(next, f, name);
  return next;
}

async function nodeAdd(args: string[]) {
  const { values, positionals } = parse(args, NODE_OPTS);
  const name = need(positionals[0], "node name");
  const kind = need(values.kind, `--kind (${NODE_KINDS.join(", ")})`);
  if (values.name) throw new UsageError("--name is for node edit; give the name as the first argument");
  const input = await nodeInput(values);
  if (input.view !== undefined && kind !== "ui") throw new UsageError("--view only applies to ui nodes");
  const { entry, project } = load(values.project);
  let next = addNode(project, { ...input, name, kind: input.kind ?? (kind as NodeInput["kind"]) });
  next = wireUp(next, name, list(values.to), list(values.from));
  reportProblems(next, [name], !!values.force);
  const wires = [...list(values.to).map((t) => `→ ${t}`), ...list(values.from).map((f) => `← ${f}`)];
  save(entry, next, `Added ${kind} "${name}"${wires.length ? ` wired ${wires.join(", ")}` : ""}`);
}

async function nodeEdit(args: string[]) {
  const { values, positionals } = parse(args, NODE_OPTS);
  const name = need(positionals[0], "node name");
  const patch = await nodeInput(values);
  const to = list(values.to);
  const from = list(values.from);
  if (!Object.keys(patch).length && !to.length && !from.length) {
    throw new UsageError("nothing to change (see `littlesystem help` for node edit options)");
  }
  const { entry, project } = load(values.project);
  const kind = patch.kind ?? getNode(project, name).kind;
  if (patch.view !== undefined && kind !== "ui") throw new UsageError("--view only applies to ui nodes");
  const finalName = patch.name ?? name;
  let next = updateNode(project, name, patch);
  next = wireUp(next, finalName, to, from);
  reportProblems(next, [finalName], !!values.force);
  const changed = [...Object.keys(patch), ...(to.length || from.length ? ["wires"] : [])];
  save(entry, next, `Updated "${finalName}": ${changed.join(", ")}`);
}

function nodeRemove(args: string[]) {
  const { values, positionals } = parse(args, PROJECT_OPT);
  const name = need(positionals[0], "node name");
  const { entry, project } = load(values.project);
  save(entry, removeNode(project, name), `Removed "${name}" and its wires`);
}

function nodeShow(args: string[]) {
  const { values, positionals } = parse(args, { ...PROJECT_OPT, json: { type: "boolean" } });
  const name = need(positionals[0], "node name");
  const { project } = load(values.project);
  const node = getNode(project, name);
  if (values.json) {
    console.log(JSON.stringify(node, null, 2));
    return;
  }
  const wires = project.wires
    .filter(([a, b]) => a === name || b === name)
    .map(([a, b]) => (a === name ? `→ ${b}` : `← ${a}`));
  console.log(`${node.name} (${node.kind}) at ${node.x},${node.y} size ${node.w}×${node.h}`);
  console.log(`wires: ${wires.join(", ") || "none"}\n\n--- handler (msg, ctx) ---\n${node.code}`);
  if (node.kind === "ui") console.log(`\n--- view ---\n${node.view}`);
}

function nodeList(args: string[]) {
  const { values } = parse(args, PROJECT_OPT);
  printNodes(load(values.project).project);
}

function wireCmd(sub: string | undefined, args: string[]) {
  const { values, positionals } = parse(args, PROJECT_OPT);
  const { entry, project } = load(values.project);
  if (sub === "list") return printWires(project);
  const from = need(positionals[0], "<from> node");
  const to = need(positionals[1], "<to> node");
  if (sub === "add") return save(entry, addWire(project, from, to), `Wired ${from} → ${to}`);
  if (sub === "remove" || sub === "rm") return save(entry, removeWire(project, from, to), `Unwired ${from} and ${to}`);
  throw new UsageError(`unknown wire command "${sub ?? ""}" (add, remove, list)`);
}

function check(args: string[]) {
  const { values } = parse(args, PROJECT_OPT);
  const { entry, project } = load(values.project);
  let errors = 0;
  let warnings = 0;
  for (const node of project.nodes) {
    for (const e of nodeErrors(node)) {
      errors++;
      console.log(`error   ${node.name}: ${e}`);
    }
    for (const w of nodeWarnings(project, node)) {
      warnings++;
      console.log(`warning ${node.name}: ${w}`);
    }
  }
  console.log(`${entry.slug}: ${project.nodes.length} nodes, ${errors} errors, ${warnings} warnings`);
  if (errors) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------
// app

function currentSlug(flag: string | undefined): string | undefined {
  try {
    return resolveProject(process.cwd(), flag).slug;
  } catch (e) {
    if (flag) throw e;
    return undefined;
  }
}

async function start(args: string[]) {
  const { values } = parse(args, { ...PROJECT_OPT, port: { type: "string" }, "no-open": { type: "boolean" } });
  const slug = currentSlug(values.project);
  let server = await runningServer();
  if (server && server.version !== VERSION) {
    console.log(`Restarting the app (running ${server.version}, installed ${VERSION})`);
    await stopDaemon(server);
    server = undefined;
  }
  const port = num(values.port, "port") ?? DEFAULT_PORT;
  if (server && values.port && server.port !== port) {
    await stopDaemon(server);
    server = undefined;
  }
  if (!server) server = await startDaemon(CLI_FILE, port);
  const url = appUrl(server.port, slug);
  console.log(`littlesystem is running at ${url}`);
  if (!slug) console.log(`No project yet; the canvas will create "My system". Or: littlesystem project new "My system"`);
  if (!values["no-open"] && interactive()) openBrowser(url);
}

async function status() {
  const server = await runningServer();
  if (!server) {
    console.log("Not running. Start it with: littlesystem start");
    return;
  }
  console.log(`Running at ${appUrl(server.port)} (pid ${server.pid}, v${server.version}, since ${server.startedAt})`);
}

async function stop() {
  const server = await runningServer();
  if (!server) return console.log("Not running.");
  await stopDaemon(server);
  console.log("Stopped.");
}

async function serveCmd(args: string[]) {
  const { values } = parse(args, { port: { type: "string" } });
  const port = num(values.port, "port") ?? DEFAULT_PORT;
  await serve({ port, appDir: APP_DIR, version: VERSION });
  console.log(`littlesystem ${VERSION} serving ${appUrl(port)} (pid ${process.pid})`);
}

// ---------------------------------------------------------------------------------------------
// setup

async function init() {
  const files = await offerSkill();
  for (const file of files) console.log(`Installed skill: ${pretty(file)}`);
  updateRegistry((r) => {
    r.skillOffered = true;
  });
  if (!interactive()) console.log("Not a terminal; use `littlesystem skill install --for <agent>` instead.");
  if (!listProjects().length) console.log(`\nNext: littlesystem project new "My system"`);
}

function skillCmd(sub: string | undefined, args: string[]) {
  if (sub === "show") {
    process.stdout.write(SKILL);
    return;
  }
  if (sub !== "install") throw new UsageError(`unknown skill command "${sub ?? ""}" (install, show)`);
  const { values } = parse(args, {
    for: { type: "string" },
    project: { type: "boolean" },
    dir: { type: "string" },
  });
  if (values.dir) {
    console.log(`Installed skill: ${pretty(installSkillInto(path.resolve(values.dir)))}`);
    return;
  }
  const ids = list(values.for);
  if (!ids.length) throw new UsageError(`pass --for ${HARNESSES.map((h) => h.id).join(",")} (or --dir <path>)`);
  const base = values.project ? process.cwd() : os.homedir();
  for (const id of ids) console.log(`Installed skill: ${pretty(installSkill(harnessById(id), base))}`);
}

// ---------------------------------------------------------------------------------------------

async function main(argv: string[]) {
  const [cmd, sub, ...rest] = argv;
  const args = [sub, ...rest].filter((a): a is string => a !== undefined);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return;
  }
  switch (cmd) {
    case "project": {
      const handlers: Record<string, (a: string[]) => unknown> = {
        new: projectNew,
        list: projectList,
        ls: projectList,
        show: projectShow,
        path: (a) => console.log(load(parse(a, PROJECT_OPT).values.project).entry.path),
        use: projectUse,
        add: projectAdd,
        remove: projectRemove,
        rm: projectRemove,
      };
      const handler = handlers[sub ?? ""];
      if (!handler) throw new UsageError(`unknown project command "${sub ?? ""}" (${Object.keys(handlers).join(", ")})`);
      return handler(rest);
    }
    case "node": {
      const handlers: Record<string, (a: string[]) => unknown> = {
        add: nodeAdd,
        edit: nodeEdit,
        remove: nodeRemove,
        rm: nodeRemove,
        show: nodeShow,
        list: nodeList,
        ls: nodeList,
      };
      const handler = handlers[sub ?? ""];
      if (!handler) throw new UsageError(`unknown node command "${sub ?? ""}" (${Object.keys(handlers).join(", ")})`);
      return handler(rest);
    }
    case "wire":
      return wireCmd(sub, rest);
    case "check":
      return check(args);
    case "start":
    case "open":
      return start(args);
    case "status":
      return status();
    case "stop":
      return stop();
    case "serve":
      return serveCmd(args);
    case "init":
      return init();
    case "skill":
      return skillCmd(sub, rest);
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2))
  .catch((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`littlesystem: ${process.env.LITTLESYSTEM_DEBUG ? err.stack : err.message}`);
    if (e instanceof UsageError) console.error("Run `littlesystem help` for usage.");
    process.exitCode = 1;
  })
  .finally(closePrompt);
