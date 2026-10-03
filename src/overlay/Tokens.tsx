import { Geometry2dFilters, useEditor, type TLShapeId } from "tldraw";
import { describePayload } from "../sim/engine";
import { engine, getGraph, useSimClock } from "../sim/runtime";

const PALETTE = ["#e8590c", "#1971c2", "#2f9e44", "#9c36b5", "#f08c00", "#0c8599", "#e03131"];

function colorFor(label: string) {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export function Tokens() {
  useSimClock();
  const editor = useEditor();
  const graph = getGraph();
  const now = engine.now;

  const dots = [];
  for (const msg of engine.getMessages()) {
    if (msg.internal) continue;
    let edge = graph.edges.find((e) => e.from === msg.fromId && e.to === msg.toId);
    let reversed = false;
    if (!edge) {
      edge = graph.edges.find((e) => e.from === msg.toId && e.to === msg.fromId);
      reversed = true;
    }
    if (!edge) continue;

    const arrowId = edge.arrowId as TLShapeId;
    const progress = Math.min(1, Math.max(0, (now - msg.sentAt) / (msg.deliverAt - msg.sentAt)));
    const t = reversed ? 1 - progress : progress;
    const local = editor.getShapeGeometry(arrowId).interpolateAlongEdge(t, Geometry2dFilters.EXCLUDE_LABELS);
    const point = editor.getShapePageTransform(arrowId).applyToPoint(local);
    const label = describePayload(msg.payload);

    dots.push(
      <div
        key={msg.id}
        className="ls-token"
        style={{ transform: `translate(${point.x}px, ${point.y}px)`, ["--c" as string]: colorFor(label) }}
      >
        <span className="ls-token-dot" />
        <span className="ls-token-label">{label}</span>
      </div>,
    );
  }

  return <div className="ls-tokens">{dots}</div>;
}
