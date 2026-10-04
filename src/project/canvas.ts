import {
  createShapeId,
  getArrowBindings,
  type Editor,
  type TLArrowShape,
  type TLPageId,
  type TLShapeId,
} from "tldraw";
import { DEFAULT_VIEW } from "../sim/defaults";
import { SYS_TYPE, type SysShape } from "../shapes/sysType";
import type { Project, Wire } from "./format";

const wireKey = (from: string, to: string) => `${from}\u0000${to}`;

export function connect(editor: Editor, pageId: TLPageId, from: TLShapeId, to: TLShapeId) {
  const id = createShapeId();
  editor.createShape({ id, type: "arrow", parentId: pageId, x: 0, y: 0 });
  const anchor = { normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false };
  editor.createBindings([
    { type: "arrow", fromId: id, toId: from, props: { terminal: "start", ...anchor } },
    { type: "arrow", fromId: id, toId: to, props: { terminal: "end", ...anchor } },
  ]);
}

function pageShapes(editor: Editor, pageId: TLPageId) {
  const sys: SysShape[] = [];
  const arrows: TLArrowShape[] = [];
  for (const id of editor.getPageShapeIds(pageId)) {
    const shape = editor.getShape(id);
    if (shape?.type === SYS_TYPE) sys.push(shape as SysShape);
    else if (shape?.type === "arrow") arrows.push(shape as TLArrowShape);
  }
  return { sys, arrows };
}

/** Arrows bound to a system node at both ends, as [arrow, fromNodeName, toNodeName]. */
function boundWires(editor: Editor, arrows: TLArrowShape[], nameById: Map<TLShapeId, string>) {
  const out: [TLArrowShape, string, string][] = [];
  for (const arrow of arrows) {
    const { start, end } = getArrowBindings(editor, arrow);
    const from = start && nameById.get(start.toId);
    const to = end && nameById.get(end.toId);
    if (from && to) out.push([arrow, from, to]);
  }
  return out;
}

/** The page's system as plain data (unvalidated: names may be empty or clash mid-edit). */
export function readPage(editor: Editor, pageId: TLPageId, name: string) {
  const { sys, arrows } = pageShapes(editor, pageId);
  const nameById = new Map(sys.map((s) => [s.id, s.props.name] as const));
  return {
    name,
    nodes: sys.map((s) => ({
      name: s.props.name,
      kind: s.props.kind,
      code: s.props.code,
      ...(s.props.kind === "ui" ? { view: s.props.view } : {}),
      x: s.x,
      y: s.y,
      w: s.props.w,
      h: s.props.h,
    })),
    wires: boundWires(editor, arrows, nameById).map(([, from, to]): Wire => [from, to]),
  };
}

/**
 * Makes the page match `project`, touching only what differs. Nodes are matched by name, so
 * nodes that survive keep their shape id (and therefore their simulated state).
 */
export function applyToPage(editor: Editor, pageId: TLPageId, project: Pick<Project, "nodes" | "wires">) {
  editor.run(() => {
    const { sys, arrows } = pageShapes(editor, pageId);
    const wanted = new Map(project.nodes.map((n) => [n.name, n] as const));
    const byName = new Map<string, SysShape>();
    const doomed: TLShapeId[] = [];
    for (const shape of sys) {
      if (wanted.has(shape.props.name) && !byName.has(shape.props.name)) byName.set(shape.props.name, shape);
      else doomed.push(shape.id);
    }

    const nameById = new Map(sys.map((s) => [s.id, s.props.name] as const));
    const desired = new Set(project.wires.map(([a, b]) => wireKey(a, b)));
    const kept = new Set<string>();
    const doomedSet = new Set(doomed);
    for (const [arrow, from, to] of boundWires(editor, arrows, nameById)) {
      const key = wireKey(from, to);
      const { start, end } = getArrowBindings(editor, arrow);
      const touchesDoomed = doomedSet.has(start!.toId) || doomedSet.has(end!.toId);
      if (touchesDoomed || !desired.has(key) || kept.has(key)) doomed.push(arrow.id);
      else kept.add(key);
    }
    if (doomed.length) editor.deleteShapes(doomed);

    const idByName = new Map<string, TLShapeId>();
    for (const node of project.nodes) {
      const props = {
        w: node.w,
        h: node.h,
        kind: node.kind,
        name: node.name,
        code: node.code,
        ...(node.kind === "ui" ? { view: node.view ?? DEFAULT_VIEW } : {}),
      };
      const shape = byName.get(node.name);
      if (!shape) {
        const id = createShapeId();
        editor.createShape<SysShape>({
          id,
          type: SYS_TYPE,
          parentId: pageId,
          x: node.x,
          y: node.y,
          props: { view: DEFAULT_VIEW, ...props },
        });
        idByName.set(node.name, id);
        continue;
      }
      idByName.set(node.name, shape.id);
      const changed = Object.fromEntries(
        Object.entries(props).filter(([k, v]) => shape.props[k as keyof typeof props] !== v),
      );
      const moved = Math.round(shape.x) !== node.x || Math.round(shape.y) !== node.y;
      if (moved || Object.keys(changed).length) {
        editor.updateShape<SysShape>({
          id: shape.id,
          type: SYS_TYPE,
          ...(moved ? { x: node.x, y: node.y } : {}),
          props: changed,
        });
      }
    }

    for (const [from, to] of project.wires) {
      if (kept.has(wireKey(from, to))) continue;
      const a = idByName.get(from);
      const b = idByName.get(to);
      if (a && b) connect(editor, pageId, a, b);
    }
  });
}
