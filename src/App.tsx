import { useEffect, useState, useSyncExternalStore } from "react";
import { createShapeId, Tldraw, useValue, type Editor, type TLComponents } from "tldraw";
import { loadDemo } from "./demo";
import { Tokens } from "./overlay/Tokens";
import { FileSync, hasLocalServer } from "./project/fileSync";
import { NODE_KINDS } from "./project/format";
import { SysShapeUtil } from "./shapes/SysShapeUtil";
import { SYS_TYPE, type SysShape } from "./shapes/sysType";
import { DEFAULT_CODE, DEFAULT_SIZE, DEFAULT_VIEW } from "./sim/defaults";
import type { NodeKind } from "./sim/engine";
import { attachEditor, engine, getGraph, useSimClock, useSimState } from "./sim/runtime";

const shapeUtils = [SysShapeUtil];
const components: TLComponents = { OnTheCanvas: Tokens };
const SPEEDS = [0.25, 0.5, 1, 2, 4];

/**
 * "files": served by the littlesystem CLI, each page is a project file on disk.
 * "browser": a plain static deploy, everything lives in the browser's storage.
 */
type Mode = "files" | "browser";

export default function App() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [sync, setSync] = useState<FileSync | null>(null);

  useEffect(() => {
    void hasLocalServer().then((ok) => setMode(ok ? "files" : "browser"));
  }, []);

  if (!mode) return null;

  return (
    <div className="ls-app">
      <div className="ls-canvas">
        <Tldraw
          persistenceKey={mode === "browser" ? "littlesystem" : undefined}
          licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
          shapeUtils={shapeUtils}
          components={components}
          onMount={(ed) => {
            const detach = attachEditor(ed);
            setEditor(ed);
            if (mode === "browser") {
              if (ed.getCurrentPageShapeIds().size === 0) loadDemo(ed);
              return detach;
            }
            const fileSync = new FileSync(ed);
            setSync(fileSync);
            return () => {
              fileSync.dispose();
              detach();
            };
          }}
        />
      </div>
      {editor && <SidePanel editor={editor} sync={sync} />}
    </div>
  );
}

function SidePanel({ editor, sync }: { editor: Editor; sync: FileSync | null }) {
  return (
    <aside className="ls-panel">
      {sync && <FileStatus sync={sync} />}
      <SimControls editor={editor} />
      <AddNodes editor={editor} />
      <Inspector editor={editor} />
      <EventLog />
    </aside>
  );
}

function FileStatus({ sync }: { sync: FileSync }) {
  useSyncExternalStore(sync.subscribe, sync.getVersion);
  const status = sync.getStatus();
  return (
    <section className="ls-section ls-file">
      {!status.connected ? (
        <span className="ls-file-error">Reconnecting to littlesystem…</span>
      ) : status.error ? (
        <span className="ls-file-error">{status.error}</span>
      ) : status.saving ? (
        <span>Saving…</span>
      ) : (
        <span className="ls-file-ok">Saved</span>
      )}
      {status.path && (
        <code title={status.path}>
          <bdi>{status.path}</bdi>
        </code>
      )}
    </section>
  );
}

function SimControls({ editor }: { editor: Editor }) {
  useSimClock();
  return (
    <section className="ls-section ls-controls">
      <button onClick={() => engine.setPlaying(!engine.playing)}>
        {engine.playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <button onClick={() => engine.step()} disabled={engine.playing}>
        Step
      </button>
      <button onClick={() => engine.reset()}>Reset</button>
      <select value={engine.speed} onChange={(e) => engine.setSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <span className="ls-clock">
        t={(engine.now / 1000).toFixed(1)}s · {engine.getMessages().filter((m) => !m.internal).length} in flight
      </span>
      <button
        className="ls-link"
        onClick={() => {
          const empty = getGraph().nodes.size === 0;
          if (empty || confirm("Replace the system on this page with the coffee-shop demo?")) loadDemo(editor);
        }}
      >
        Load demo
      </button>
    </section>
  );
}

function AddNodes({ editor }: { editor: Editor }) {
  const add = (kind: NodeKind) => {
    const names = new Set(getGraph().idByName.keys());
    let i = 1;
    while (names.has(`${kind}-${i}`)) i++;
    const size = DEFAULT_SIZE[kind];
    const center = editor.getViewportPageBounds().center;
    const id = createShapeId();
    editor.createShape({
      id,
      type: SYS_TYPE,
      x: center.x - size.w / 2,
      y: center.y - size.h / 2,
      props: { ...size, kind, name: `${kind}-${i}`, code: DEFAULT_CODE[kind], view: DEFAULT_VIEW },
    });
    editor.select(id);
  };
  return (
    <section className="ls-section ls-add">
      {NODE_KINDS.map((k) => (
        <button key={k} onClick={() => add(k)}>
          + {k}
        </button>
      ))}
      <span className="ls-hint">Wire nodes with the arrow tool (A).</span>
    </section>
  );
}

function Inspector({ editor }: { editor: Editor }) {
  const shape = useValue(
    "selected sys shape",
    () => {
      const s = editor.getOnlySelectedShape();
      return s?.type === SYS_TYPE ? (s as SysShape) : null;
    },
    [editor],
  );
  useSimState();

  if (!shape) {
    return (
      <section className="ls-section ls-inspector ls-hint">
        Select a node to edit its behavior.
      </section>
    );
  }

  const update = (props: Partial<SysShape["props"]>) =>
    editor.updateShape<SysShape>({ id: shape.id, type: SYS_TYPE, props });
  const compileError = engine.compileError(shape.props.code);

  return (
    <section className="ls-section ls-inspector">
      <div className="ls-field-row">
        <input value={shape.props.name} onChange={(e) => update({ name: e.target.value })} />
        <select
          value={shape.props.kind}
          onChange={(e) => {
            const kind = e.target.value as NodeKind;
            update({ kind, ...DEFAULT_SIZE[kind], code: DEFAULT_CODE[kind] });
          }}
        >
          {NODE_KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </div>
      {shape.props.kind === "ui" && (
        <>
          <label>View (JSX)</label>
          <CodeArea value={shape.props.view} onChange={(view) => update({ view })} rows={12} />
        </>
      )}
      <label>Handler (msg, ctx)</label>
      <CodeArea value={shape.props.code} onChange={(code) => update({ code })} rows={10} />
      {compileError && <pre className="ls-error">{compileError}</pre>}
      <label>State</label>
      <pre className="ls-state ls-state-full">{JSON.stringify(engine.getState(shape.id), null, 2)}</pre>
    </section>
  );
}

function CodeArea({
  value,
  onChange,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <textarea
      className="ls-code"
      spellCheck={false}
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        const el = e.currentTarget;
        const { selectionStart: s, selectionEnd: end } = el;
        onChange(value.slice(0, s) + "  " + value.slice(end));
        requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
      }}
    />
  );
}

function EventLog() {
  useSimState();
  const logs = engine.getLogs();
  return (
    <section className="ls-section ls-log">
      {logs.length === 0 && <div className="ls-hint">Events show up here.</div>}
      {[...logs].reverse().map((l) => (
        <div key={l.seq} className={`ls-log-${l.level}`}>
          <span className="ls-log-t">{(l.t / 1000).toFixed(1)}</span> {l.text}
        </div>
      ))}
    </section>
  );
}
