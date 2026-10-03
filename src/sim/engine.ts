export type NodeKind = "service" | "db" | "queue" | "ui";

export type NodeState = Record<string, unknown>;

export interface SimNode {
  id: string;
  name: string;
  kind: NodeKind;
  code: string;
}

export interface SimEdge {
  arrowId: string;
  from: string;
  to: string;
}

export interface Graph {
  nodes: Map<string, SimNode>;
  idByName: Map<string, string>;
  edges: SimEdge[];
}

export interface Msg {
  id: number;
  fromId: string;
  toId: string;
  payload: unknown;
  sentAt: number;
  deliverAt: number;
  internal: boolean;
}

export interface HandlerMsg {
  id: number;
  from: string;
  fromId: string;
  payload: unknown;
}

export interface Ctx {
  self: string;
  now: number;
  state: NodeState;
  out: string[];
  send(to: string, payload: unknown, opts?: { latency?: number }): void;
  reply(msg: HandlerMsg, payload: unknown, opts?: { latency?: number }): void;
  forward(payload: unknown, opts?: { latency?: number }): void;
  after(ms: number, payload: unknown): void;
  rand(): number;
  log(...args: unknown[]): void;
}

type Handler = (msg: HandlerMsg, ctx: Ctx) => void;

export interface LogEntry {
  seq: number;
  t: number;
  level: "deliver" | "error" | "log";
  node: string;
  text: string;
}

export interface NodeStats {
  handled: number;
  errors: number;
  lastAt: number;
  lastError?: string;
}

const DEFAULT_LATENCY = 700;
const MAX_LOG = 200;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function describePayload(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const label = p.type ?? p.op;
    if (typeof label === "string") return label;
  }
  return typeof payload === "string" ? payload : "msg";
}

export class Engine {
  now = 0;
  playing = true;
  speed = 1;

  private inFlight: Msg[] = [];
  private states = new Map<string, NodeState>();
  private stats = new Map<string, NodeStats>();
  private logs: LogEntry[] = [];
  private handlers = new Map<string, Handler | Error>();
  private rng = mulberry32(1);
  private nextMsgId = 1;
  private nextLogSeq = 1;

  private stateVersion = 0;
  private clockVersion = 0;
  private listeners = new Set<() => void>();

  constructor(private readGraph: () => Graph) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getStateVersion = () => this.stateVersion;
  getClockVersion = () => this.clockVersion;

  private notify(stateChanged: boolean) {
    this.clockVersion++;
    if (stateChanged) this.stateVersion++;
    for (const fn of this.listeners) fn();
  }

  getMessages(): readonly Msg[] {
    return this.inFlight;
  }
  getLogs(): readonly LogEntry[] {
    return this.logs;
  }
  getState(id: string): NodeState {
    let s = this.states.get(id);
    if (!s) {
      s = {};
      this.states.set(id, s);
    }
    return s;
  }
  getStats(id: string): NodeStats | undefined {
    return this.stats.get(id);
  }
  queryByName(name: string): NodeState | undefined {
    const id = this.readGraph().idByName.get(name);
    return id ? this.getState(id) : undefined;
  }
  compileError(code: string): string | undefined {
    const h = this.compile(code);
    return h instanceof Error ? h.message : undefined;
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
    this.notify(false);
  }
  setSpeed(speed: number) {
    this.speed = speed;
    this.notify(false);
  }

  reset() {
    this.now = 0;
    this.inFlight = [];
    this.states.clear();
    this.stats.clear();
    this.logs = [];
    this.rng = mulberry32(1);
    this.nextMsgId = 1;
    this.notify(true);
  }

  tick(realDt: number) {
    if (!this.playing) return;
    this.runUntil(this.now + realDt * this.speed);
  }

  step() {
    const next = this.inFlight[0];
    if (!next) return;
    this.runUntil(next.deliverAt);
  }

  private runUntil(t: number) {
    let delivered = false;
    while (this.inFlight[0] && this.inFlight[0].deliverAt <= t) {
      const msg = this.inFlight.shift()!;
      this.now = msg.deliverAt;
      this.deliver(msg);
      delivered = true;
    }
    this.now = t;
    this.notify(delivered);
  }

  /** Entry point for UI frames: send a message from a node into the graph. */
  emit(fromId: string, to: string, payload: unknown) {
    this.send(this.readGraph(), fromId, to, payload);
    this.notify(true);
  }

  private compile(code: string): Handler | Error {
    let h = this.handlers.get(code);
    if (!h) {
      try {
        h = new Function("msg", "ctx", code) as Handler;
      } catch (e) {
        h = e instanceof Error ? e : new Error(String(e));
      }
      this.handlers.set(code, h);
    }
    return h;
  }

  private pushLog(level: LogEntry["level"], node: string, text: string) {
    this.logs.push({ seq: this.nextLogSeq++, t: this.now, level, node, text });
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
  }

  private enqueue(msg: Omit<Msg, "id">) {
    const m: Msg = { ...msg, id: this.nextMsgId++ };
    let i = this.inFlight.length;
    while (i > 0 && this.inFlight[i - 1]!.deliverAt > m.deliverAt) i--;
    this.inFlight.splice(i, 0, m);
  }

  private send(
    graph: Graph,
    fromId: string,
    to: string,
    payload: unknown,
    opts?: { latency?: number },
  ) {
    const fromName = graph.nodes.get(fromId)?.name ?? "?";
    const toId = graph.idByName.get(to) ?? (graph.nodes.has(to) ? to : undefined);
    if (!toId) {
      this.pushLog("error", fromName, `send to unknown node "${to}"`);
      return;
    }
    const wired = graph.edges.some(
      (e) => (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId),
    );
    if (!wired) {
      this.pushLog("error", fromName, `no wire between ${fromName} and ${to} — draw an arrow`);
      return;
    }
    const base = opts?.latency ?? DEFAULT_LATENCY;
    const latency = base * (0.85 + this.rng() * 0.3);
    this.enqueue({
      fromId,
      toId,
      payload: structuredClone(payload),
      sentAt: this.now,
      deliverAt: this.now + latency,
      internal: false,
    });
  }

  private deliver(msg: Msg) {
    const graph = this.readGraph();
    const node = graph.nodes.get(msg.toId);
    if (!node) return;
    const fromName = graph.nodes.get(msg.fromId)?.name ?? "?";

    const stats = this.stats.get(node.id) ?? { handled: 0, errors: 0, lastAt: -Infinity };
    this.stats.set(node.id, stats);

    if (!msg.internal) {
      this.pushLog("deliver", node.name, `${fromName} → ${node.name}: ${JSON.stringify(msg.payload)}`);
    }

    const handler = this.compile(node.code);
    if (handler instanceof Error) {
      stats.errors++;
      stats.lastError = handler.message;
      this.pushLog("error", node.name, `compile: ${handler.message}`);
      return;
    }

    const ctx: Ctx = {
      self: node.name,
      now: this.now,
      state: this.getState(node.id),
      out: graph.edges
        .filter((e) => e.from === node.id)
        .map((e) => graph.nodes.get(e.to)?.name)
        .filter((n): n is string => !!n),
      send: (to, payload, opts) => this.send(graph, node.id, to, payload, opts),
      reply: (m, payload, opts) => this.send(graph, node.id, m.fromId, payload, opts),
      forward: (payload, opts) => {
        for (const to of ctx.out) this.send(graph, node.id, to, payload, opts);
      },
      after: (ms, payload) =>
        this.enqueue({
          fromId: node.id,
          toId: node.id,
          payload,
          sentAt: this.now,
          deliverAt: this.now + ms,
          internal: true,
        }),
      rand: this.rng,
      log: (...args) =>
        this.pushLog(
          "log",
          node.name,
          args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
        ),
    };

    try {
      handler({ id: msg.id, from: fromName, fromId: msg.fromId, payload: msg.payload }, ctx);
      if (!msg.internal) {
        stats.handled++;
        stats.lastAt = this.now;
      }
    } catch (e) {
      stats.errors++;
      stats.lastError = e instanceof Error ? e.message : String(e);
      this.pushLog("error", node.name, stats.lastError);
    }
  }
}
