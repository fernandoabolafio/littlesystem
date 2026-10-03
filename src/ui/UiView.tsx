import React, { Component, type ReactNode } from "react";
import { transform } from "sucrase";
import { engine, useSimState } from "../sim/runtime";
import type { NodeState } from "../sim/engine";

interface ViewProps {
  state: NodeState;
  query: (name: string) => NodeState | undefined;
  send: (to: string, payload: unknown) => void;
}

type ViewComponent = (props: ViewProps) => ReactNode;

const cache = new Map<string, ViewComponent | Error>();

function compileView(source: string): ViewComponent | Error {
  let compiled = cache.get(source);
  if (!compiled) {
    try {
      const js = transform(source, {
        transforms: ["jsx"],
        jsxRuntime: "classic",
        production: true,
      }).code;
      const factory = new Function("React", `${js}\nreturn View;`) as (r: typeof React) => unknown;
      const view = factory(React);
      if (typeof view !== "function") throw new Error("Define a function called View");
      compiled = view as ViewComponent;
    } catch (e) {
      compiled = e instanceof Error ? e : new Error(String(e));
    }
    cache.set(source, compiled);
  }
  return compiled;
}

class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }
  render() {
    if (this.state.error) return <pre className="ls-error">{this.state.error.message}</pre>;
    return this.props.children;
  }
}

const INTERACTIVE = "button, input, textarea, select, a, label, [data-interactive]";

export function UiView({ nodeId, source }: { nodeId: string; source: string }) {
  useSimState();
  const View = compileView(source);
  if (View instanceof Error) return <pre className="ls-error">{View.message}</pre>;

  const props: ViewProps = {
    state: engine.getState(nodeId),
    query: (name) => engine.queryByName(name),
    send: (to, payload) => engine.emit(nodeId, to, payload),
  };

  return (
    <div
      className="ls-ui"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) e.stopPropagation();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Boundary resetKey={source}>
        <View {...props} />
      </Boundary>
    </div>
  );
}
