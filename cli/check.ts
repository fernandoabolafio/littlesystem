import { transform } from "sucrase";
import type { Project, ProjectNode } from "../src/project/format";

export function handlerError(code: string): string | undefined {
  try {
    new Function("msg", "ctx", code);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export function viewError(source: string): string | undefined {
  try {
    const js = transform(source, { transforms: ["jsx"], jsxRuntime: "classic", production: true }).code;
    new Function("React", `${js}\nreturn View;`);
  } catch (e) {
    return (e as Error).message;
  }
  if (!/\b(function\s+View\b|(const|let|var)\s+View\s*=)/.test(source)) return "define a function called View";
  return undefined;
}

/** Compile errors that would stop a node from working at all. */
export function nodeErrors(node: Pick<ProjectNode, "kind" | "code" | "view">): string[] {
  const errors: string[] = [];
  const h = handlerError(node.code);
  if (h) errors.push(`handler: ${h}`);
  if (node.kind === "ui") {
    const v = viewError(node.view ?? "");
    if (v) errors.push(`view: ${v}`);
  }
  return errors;
}

const literalTargets = (source: string, fn: RegExp) =>
  [...source.matchAll(fn)].map((m) => m[1]!).filter((t, i, all) => all.indexOf(t) === i);

/** Best-effort static checks: sends/queries to string-literal node names that can't work. */
export function nodeWarnings(project: Project, node: ProjectNode): string[] {
  const names = new Set(project.nodes.map((n) => n.name));
  const wired = (a: string, b: string) =>
    project.wires.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const warnings: string[] = [];
  const sends = [
    ...literalTargets(node.code, /ctx\.send\(\s*["'`]([^"'`$]+)["'`]/g),
    ...(node.kind === "ui" ? literalTargets(node.view ?? "", /\bsend\(\s*["'`]([^"'`$]+)["'`]/g) : []),
  ];
  for (const to of new Set(sends)) {
    if (!names.has(to)) warnings.push(`sends to "${to}", but there is no node with that name`);
    else if (!wired(node.name, to)) warnings.push(`sends to "${to}", but they aren't wired (littlesystem wire add ${node.name} ${to})`);
  }
  if (node.kind === "ui") {
    for (const q of literalTargets(node.view ?? "", /\bquery\(\s*["'`]([^"'`$]+)["'`]/g)) {
      if (!names.has(q)) warnings.push(`queries "${q}", but there is no node with that name`);
    }
  }
  return warnings;
}
