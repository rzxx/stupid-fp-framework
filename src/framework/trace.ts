import type { JsonRecord } from "./json";

export type TracePhase =
  | "message"
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
  detail?: JsonRecord;
};

export type TraceStatus = "running" | "success" | "error";

export type TraceSnapshot = {
  traceId: string;
  label: string;
  status: TraceStatus;
  events: TraceEvent[];
};

export class TraceStore {
  readonly #traces: TraceSnapshot[] = [];
  #nextId = 1;

  start(label: string): TraceSnapshot {
    const trace: TraceSnapshot = {
      traceId: `trace-${this.#nextId++}`,
      label,
      status: "running",
      events: [],
    };

    this.#traces.unshift(trace);
    return trace;
  }

  add(trace: TraceSnapshot, phase: TracePhase, label: string, detail?: JsonRecord): void {
    trace.events.push({
      at: new Date().toISOString(),
      phase,
      label,
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

  list(): TraceSnapshot[] {
    return this.#traces.map((trace) => ({
      ...trace,
      events: [...trace.events],
    }));
  }
}
