import { useSyncExternalStore } from "react";
import { getArrowBindings, type Editor, type TLArrowShape } from "tldraw";
import { Engine, type Graph } from "./engine";
import { SYS_TYPE, type SysShape } from "../shapes/sysType";

let editorRef: Editor | null = null;
let graphCache: Graph | null = null;

const EMPTY_GRAPH: Graph = { nodes: new Map(), idByName: new Map(), edges: [] };

function readGraph(): Graph {
  if (!editorRef) return EMPTY_GRAPH;
  if (graphCache) return graphCache;
  const editor = editorRef;
  const graph: Graph = { nodes: new Map(), idByName: new Map(), edges: [] };

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== SYS_TYPE) continue;
    const { name, kind, code } = (shape as SysShape).props;
    graph.nodes.set(shape.id, { id: shape.id, name, kind, code });
    graph.idByName.set(name, shape.id);
  }
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "arrow") continue;
    const { start, end } = getArrowBindings(editor, shape as TLArrowShape);
    if (!start || !end) continue;
    if (!graph.nodes.has(start.toId) || !graph.nodes.has(end.toId)) continue;
    graph.edges.push({ arrowId: shape.id, from: start.toId, to: end.toId });
  }
  graphCache = graph;
  return graph;
}

export const engine = new Engine(readGraph);

let lastFrame = performance.now();
function frame(t: number) {
  engine.tick(Math.min(100, t - lastFrame));
  lastFrame = t;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// The engine is a module-level singleton driven by the loop above; hot-swapping this module
// would leave UI and clock pointing at different engines, so force a full reload instead.
import.meta.hot?.accept(() => window.location.reload());

export function attachEditor(editor: Editor) {
  editorRef = editor;
  graphCache = null;
  return editor.store.listen(
    () => {
      graphCache = null;
    },
    { scope: "document" },
  );
}

export function getGraph() {
  return readGraph();
}

/** Re-render when simulated state changes (messages delivered, reset). */
export function useSimState() {
  return useSyncExternalStore(engine.subscribe, engine.getStateVersion);
}

/** True for a moment after the node handles a message; only re-renders when it flips. */
export function useRecentlyActive(nodeId: string) {
  return useSyncExternalStore(engine.subscribe, () => {
    const stats = engine.getStats(nodeId);
    return stats ? engine.now - stats.lastAt < 250 : false;
  });
}

/** Re-render every simulated frame (for animation). */
export function useSimClock() {
  return useSyncExternalStore(engine.subscribe, engine.getClockVersion);
}
