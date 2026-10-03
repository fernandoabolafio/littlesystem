import { BaseBoxShapeUtil, HTMLContainer, T } from "tldraw";
import { DEFAULT_CODE, DEFAULT_SIZE, DEFAULT_VIEW } from "../sim/defaults";
import { engine, useRecentlyActive, useSimClock, useSimState } from "../sim/runtime";
import { UiView } from "../ui/UiView";
import { SYS_TYPE, type SysShape } from "./sysType";
import type { NodeKind, NodeState } from "../sim/engine";

const KIND_ICON: Record<NodeKind, string> = {
  service: "⚙",
  db: "⛁",
  queue: "≡",
  cron: "⏱",
  ui: "▢",
};

export class SysShapeUtil extends BaseBoxShapeUtil<SysShape> {
  static override type = SYS_TYPE;
  static override props = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum("service", "db", "queue", "cron", "ui"),
    name: T.string,
    code: T.string,
    view: T.string,
  };

  getDefaultProps(): SysShape["props"] {
    return {
      ...DEFAULT_SIZE.service,
      kind: "service",
      name: "service",
      code: DEFAULT_CODE.service,
      view: DEFAULT_VIEW,
    };
  }

  override canEdit() {
    return false;
  }

  component(shape: SysShape) {
    return (
      <HTMLContainer style={{ pointerEvents: shape.props.kind === "ui" ? "all" : undefined }}>
        <SysNode shape={shape} />
      </HTMLContainer>
    );
  }

  getIndicatorPath(shape: SysShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }
}

function SysNode({ shape }: { shape: SysShape }) {
  useSimState();
  const active = useRecentlyActive(shape.id);
  const { kind, name } = shape.props;
  const stats = engine.getStats(shape.id);
  const state = engine.getState(shape.id);
  const failing = !!stats?.errors;

  return (
    <div className={`ls-node ls-kind-${kind} ${active ? "is-active" : ""} ${failing ? "is-failing" : ""}`}>
      <header>
        <span className="ls-icon">{KIND_ICON[kind]}</span>
        <span className="ls-name">{name}</span>
        <span className="ls-stats">
          {stats?.handled ?? 0}
          {failing ? ` · ${stats!.errors}!` : ""}
        </span>
      </header>
      <div className="ls-body">
        {kind === "ui" ? (
          <UiView nodeId={shape.id} source={shape.props.view} />
        ) : kind === "db" ? (
          <DbBody state={state} />
        ) : kind === "queue" ? (
          <QueueBody state={state} />
        ) : kind === "cron" ? (
          <>
            <CronCountdown nodeId={shape.id} />
            <StateBody state={state} />
          </>
        ) : (
          <StateBody state={state} />
        )}
      </div>
    </div>
  );
}

function DbBody({ state }: { state: NodeState }) {
  const tables = Object.entries(state).filter(([, v]) => Array.isArray(v)) as [string, unknown[]][];
  if (!tables.length) return <div className="ls-empty">empty</div>;
  return (
    <div className="ls-tables">
      {tables.map(([table, rows]) => (
        <div key={table}>
          <div className="ls-table-name">
            {table} <span>({rows.length})</span>
          </div>
          {rows.slice(-4).map((row, i) => (
            <div key={i} className="ls-row">
              {JSON.stringify(row)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function QueueBody({ state }: { state: NodeState }) {
  const items = Array.isArray(state.items) ? state.items : [];
  return (
    <div className="ls-queue">
      {items.length === 0 && <div className="ls-empty">empty</div>}
      {items.slice(0, 12).map((_, i) => (
        <div key={i} className="ls-queue-item" />
      ))}
      {items.length > 12 && <span className="ls-empty">+{items.length - 12}</span>}
    </div>
  );
}

function CronCountdown({ nodeId }: { nodeId: string }) {
  useSimClock();
  const next = engine.nextWakeAt(nodeId);
  if (next === undefined) return <div className="ls-cron ls-cron-stopped">stopped</div>;
  return <div className="ls-cron">next run in {((next - engine.now) / 1000).toFixed(1)}s</div>;
}

function StateBody({ state }: { state: NodeState }) {
  const keys = Object.keys(state);
  if (!keys.length) return <div className="ls-empty">no state</div>;
  return <pre className="ls-state">{JSON.stringify(state, null, 1)}</pre>;
}
