import { DEFAULT_CODE, DEFAULT_SIZE, DEFAULT_VIEW } from "../sim/defaults";
import type { NodeKind } from "../sim/engine";

export const NODE_KINDS: readonly NodeKind[] = ["service", "db", "queue", "cron", "ui"];

export interface ProjectNode {
  name: string;
  kind: NodeKind;
  code: string;
  /** Only meaningful for `ui` nodes. */
  view?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Wire = [from: string, to: string];

export interface Project {
  name: string;
  nodes: ProjectNode[];
  wires: Wire[];
}

const FORMAT_VERSION = 1;
const PLACE_GAP = 80;

export class ProjectError extends Error {}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

export function emptyProject(name: string): Project {
  return { name, nodes: [], wires: [] };
}

/** Next free spot to the right of everything on the canvas. */
export function nextPosition(nodes: readonly Pick<ProjectNode, "x" | "y" | "w">[]) {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...nodes.map((n) => n.x + n.w));
  const top = Math.min(...nodes.map((n) => n.y));
  return { x: right + PLACE_GAP, y: top };
}

function readCode(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((l) => typeof l === "string")) return value.join("\n");
  throw new ProjectError(`${where} must be a string or an array of lines`);
}

function readNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectError(`${where} must be a number`);
  }
  return Math.round(value);
}

/** Validates anything that looks like a project file and fills in defaults. Throws ProjectError. */
export function parseProject(raw: unknown): Project {
  if (!raw || typeof raw !== "object") throw new ProjectError("project must be a JSON object");
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) {
    throw new ProjectError(`"name" must be a non-empty string`);
  }
  if (r.nodes !== undefined && !Array.isArray(r.nodes)) throw new ProjectError(`"nodes" must be an array`);
  if (r.wires !== undefined && !Array.isArray(r.wires)) throw new ProjectError(`"wires" must be an array`);

  const nodes: ProjectNode[] = [];
  const unplaced: ProjectNode[] = [];
  const names = new Set<string>();
  for (const [i, value] of ((r.nodes as unknown[]) ?? []).entries()) {
    if (!value || typeof value !== "object") throw new ProjectError(`nodes[${i}] must be an object`);
    const n = value as Record<string, unknown>;
    const where = `nodes[${i}]`;
    if (typeof n.name !== "string" || !n.name.trim()) {
      throw new ProjectError(`${where}.name must be a non-empty string`);
    }
    const name = n.name.trim();
    if (names.has(name)) throw new ProjectError(`duplicate node name "${name}"`);
    names.add(name);
    if (!isNodeKind(n.kind)) {
      throw new ProjectError(`node "${name}": kind must be one of ${NODE_KINDS.join(", ")}`);
    }
    const kind = n.kind;
    const x = readNumber(n.x, `node "${name}".x`);
    const y = readNumber(n.y, `node "${name}".y`);
    const node: ProjectNode = {
      name,
      kind,
      code: readCode(n.code, `node "${name}".code`) ?? DEFAULT_CODE[kind],
      x: x ?? 0,
      y: y ?? 0,
      w: readNumber(n.w, `node "${name}".w`) ?? DEFAULT_SIZE[kind].w,
      h: readNumber(n.h, `node "${name}".h`) ?? DEFAULT_SIZE[kind].h,
    };
    if (kind === "ui") node.view = readCode(n.view, `node "${name}".view`) ?? DEFAULT_VIEW;
    nodes.push(node);
    if (x === undefined && y === undefined) unplaced.push(node);
  }

  const placed = nodes.filter((n) => !unplaced.includes(n));
  for (const node of unplaced) {
    Object.assign(node, nextPosition(placed));
    placed.push(node);
  }

  const wires: Wire[] = [];
  const seen = new Set<string>();
  for (const [i, value] of ((r.wires as unknown[]) ?? []).entries()) {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string"
    ) {
      throw new ProjectError(`wires[${i}] must be a [from, to] pair of node names`);
    }
    const [from, to] = value as [string, string];
    for (const end of [from, to]) {
      if (!names.has(end)) throw new ProjectError(`wire ${from} → ${to}: no node named "${end}"`);
    }
    const key = `${from}\u0000${to}`;
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    wires.push([from, to]);
  }

  return { name: r.name.trim(), nodes, wires };
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byWire = (a: Wire, b: Wire) => {
  const ka = `${a[0]}\u0000${a[1]}`;
  const kb = `${b[0]}\u0000${b[1]}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * Canonical on-disk form. Sorted and with code split into lines, so the browser, CLI and
 * server all produce byte-identical files and git diffs stay readable.
 */
export function serializeProject(project: Project): string {
  const file = {
    littlesystem: FORMAT_VERSION,
    name: project.name,
    nodes: [...project.nodes].sort(byName).map((n) => ({
      name: n.name,
      kind: n.kind,
      x: Math.round(n.x),
      y: Math.round(n.y),
      w: Math.round(n.w),
      h: Math.round(n.h),
      code: n.code.split("\n"),
      ...(n.kind === "ui" ? { view: (n.view ?? DEFAULT_VIEW).split("\n") } : {}),
    })),
    wires: [...project.wires].sort(byWire),
  };
  return JSON.stringify(file, null, 2) + "\n";
}

export function parseProjectText(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseProject(raw);
}

/** True for JSON files that declare themselves littlesystem projects. */
export function looksLikeProject(text: string): boolean {
  try {
    const raw = JSON.parse(text) as unknown;
    return !!raw && typeof raw === "object" && "littlesystem" in raw;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Edits used by the CLI. Each returns a new project and throws ProjectError on bad input.

export function getNode(project: Project, name: string): ProjectNode {
  const node = project.nodes.find((n) => n.name === name);
  if (!node) {
    const known = project.nodes.map((n) => n.name).join(", ") || "none";
    throw new ProjectError(`no node named "${name}" (nodes: ${known})`);
  }
  return node;
}

export interface NodeInput {
  name: string;
  kind: NodeKind;
  code?: string;
  view?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export function addNode(project: Project, input: NodeInput): Project {
  if (project.nodes.some((n) => n.name === input.name)) {
    throw new ProjectError(`a node named "${input.name}" already exists`);
  }
  const size = DEFAULT_SIZE[input.kind];
  const w = input.w ?? size.w;
  const auto = nextPosition(project.nodes);
  const node: ProjectNode = {
    name: input.name,
    kind: input.kind,
    code: input.code ?? DEFAULT_CODE[input.kind],
    x: input.x ?? auto.x,
    y: input.y ?? auto.y,
    w,
    h: input.h ?? size.h,
  };
  if (input.kind === "ui") node.view = input.view ?? DEFAULT_VIEW;
  return { ...project, nodes: [...project.nodes, node] };
}

export function updateNode(
  project: Project,
  name: string,
  patch: Partial<NodeInput>,
): Project {
  const node = getNode(project, name);
  const nextName = patch.name ?? name;
  if (nextName !== name && project.nodes.some((n) => n.name === nextName)) {
    throw new ProjectError(`a node named "${nextName}" already exists`);
  }
  const updated: ProjectNode = { ...node };
  for (const key of ["name", "kind", "code", "view", "x", "y", "w", "h"] as const) {
    if (patch[key] !== undefined) Object.assign(updated, { [key]: patch[key] });
  }
  if (updated.kind === "ui") updated.view ??= DEFAULT_VIEW;
  else delete updated.view;
  const rename = (n: string) => (n === name ? nextName : n);
  return {
    ...project,
    nodes: project.nodes.map((n) => (n === node ? updated : n)),
    wires: project.wires.map(([a, b]) => [rename(a), rename(b)]),
  };
}

export function removeNode(project: Project, name: string): Project {
  getNode(project, name);
  return {
    ...project,
    nodes: project.nodes.filter((n) => n.name !== name),
    wires: project.wires.filter(([a, b]) => a !== name && b !== name),
  };
}

export function addWire(project: Project, from: string, to: string): Project {
  getNode(project, from);
  getNode(project, to);
  if (from === to) throw new ProjectError("a node can't be wired to itself");
  if (project.wires.some(([a, b]) => a === from && b === to)) return project;
  return { ...project, wires: [...project.wires, [from, to]] };
}

export function removeWire(project: Project, from: string, to: string): Project {
  const wires = project.wires.filter(
    ([a, b]) => !((a === from && b === to) || (a === to && b === from)),
  );
  if (wires.length === project.wires.length) {
    throw new ProjectError(`no wire between "${from}" and "${to}"`);
  }
  return { ...project, wires };
}
