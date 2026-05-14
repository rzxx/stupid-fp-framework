import type { JsonRecord } from "./json";

export type TracePhase =
  | "message"
  | "ui"
  | "session"
  | "action"
  | "validation"
  | "auth"
  | "permission"
  | "effect"
  | "write"
  | "resource"
  | "projection"
  | "stream"
  | "error";

export type TraceEvent = {
  at: string;
  phase: TracePhase;
  label: string;
  visibility: TraceVisibility;
  detail?: JsonRecord;
};

export type TraceStatus = "running" | "success" | "error";
export type TraceVisibility = "browser" | "dev";
export type TraceAudience = TraceVisibility;

export type TraceSnapshot = {
  traceId: string;
  label: string;
  status: TraceStatus;
  scopeId?: string;
  events: TraceEvent[];
};

export type TraceReader = {
  list: () => TraceSnapshot[];
};

export class TraceStore {
  readonly #traces: TraceSnapshot[] = [];
  #nextId = 1;

  start(label: string, options?: { scopeId?: string }): TraceSnapshot {
    const trace: TraceSnapshot = {
      traceId: `trace-${this.#nextId++}`,
      label,
      status: "running",
      scopeId: options?.scopeId,
      events: [],
    };

    this.#traces.unshift(trace);
    return trace;
  }

  add(
    trace: TraceSnapshot,
    phase: TracePhase,
    label: string,
    detail?: JsonRecord,
    options?: { visibility?: TraceVisibility },
  ): void {
    trace.events.push({
      at: new Date().toISOString(),
      phase,
      label,
      visibility: options?.visibility ?? "browser",
      detail,
    });
  }

  complete(trace: TraceSnapshot): void {
    trace.status = "success";
  }

  fail(trace: TraceSnapshot, message: string): void {
    trace.status = "error";
    this.add(trace, "error", message);
  }

  list(scopeId?: string, audience: TraceAudience = "browser"): TraceSnapshot[] {
    return this.#traces
      .filter((trace) => !scopeId || trace.scopeId === scopeId)
      .map((trace) => this.snapshot(trace, audience));
  }

  snapshot(trace: TraceSnapshot, audience: TraceAudience = "browser"): TraceSnapshot {
    return {
      ...trace,
      events: trace.events.filter((event) => audience === "dev" || event.visibility === "browser"),
    };
  }

  scoped(scopeId: string): TraceReader {
    return {
      list: () => this.list(scopeId),
    };
  }
}
