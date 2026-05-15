import type { JsonValue } from "./json";
import type { ProjectionRegionSnapshot } from "./projection";

export type ConnectEnvelope = {
  type: "connect";
  route: string;
  params: Record<string, string>;
  resume?: {
    viewId: string;
    cursor: string;
  };
};

export type ClientInputEnvelope<TInput> = {
  type: "input";
  viewId: string;
  clientInputId?: string;
  input: TInput;
};

export type ClientEnvelope<TInput> = ConnectEnvelope | ClientInputEnvelope<TInput>;

export type ConnectedEnvelope = {
  type: "connected";
  viewId: string;
  cursor: string;
  resumed: boolean;
  resume: ResumeResult;
};

export type ResumeResult =
  | {
      status: "fresh";
    }
  | {
      status: "rejected";
      reason: "missing-view" | "route-mismatch";
    }
  | {
      status: "refreshed";
      reason: "current-cursor" | "stale-cursor";
    }
  | {
      status: "replayed";
      replayed: number;
    };

export type ProjectionEnvelope<TProjection> = {
  type: "projection:update";
  viewId: string;
  cursor: string;
  projectionVersion: number;
  projectionManifestVersion?: number;
  projection: TProjection;
  regions: ProjectionRegionSnapshot[];
  causedByTraceId?: string;
};

export type ProjectionPatchEnvelope = {
  type: "projection:patch";
  viewId: string;
  cursor: string;
  projectionVersion: number;
  projectionManifestVersion?: number;
  patch: {
    kind: "region-values";
    regions: {
      id: string;
      value: JsonValue;
      resources: ProjectionRegionSnapshot["resources"];
    }[];
  };
  causedByTraceId?: string;
};

export type ProgramStreamBootstrap<TProjection, TTrace> = {
  viewId: string;
  cursor: string;
  resumed: boolean;
  resume: ResumeResult;
  projectionVersion: number;
  projection: TProjection;
  traces: TTrace[];
};

export type ActionResultEnvelope = {
  type: "action:result";
  viewId: string;
  cursor: string;
  traceId: string;
  clientInputId?: string;
  action: string;
  ok: boolean;
  error?: string;
  result?: JsonValue;
};

export type ActionLifecycleEnvelope = {
  type: "action:lifecycle";
  viewId: string;
  cursor: string;
  traceId: string;
  clientInputId?: string;
  action: string;
  stage: "started" | "committed" | "failed";
};

export type TraceEnvelope<TTrace> = {
  type: "trace:update";
  viewId: string;
  cursor: string;
  trace: TTrace;
};

export type ErrorEnvelope = {
  type: "error";
  viewId?: string;
  traceId?: string;
  message: string;
};

export type ServerEnvelope<TProjection, TTrace> =
  | ConnectedEnvelope
  | ProjectionPatchEnvelope
  | ProjectionEnvelope<TProjection>
  | ActionLifecycleEnvelope
  | ActionResultEnvelope
  | TraceEnvelope<TTrace>
  | ErrorEnvelope;

export function parseClientEnvelope<TInput>(
  payload: string,
): ClientEnvelope<TInput> | ErrorEnvelope {
  try {
    const value = JSON.parse(payload) as Partial<ClientEnvelope<TInput>>;

    if (value.type === "connect") {
      if (typeof value.route !== "string" || !isStringRecord(value.params)) {
        return { type: "error", message: "Invalid connect envelope" };
      }

      if (value.resume !== undefined && !isResume(value.resume)) {
        return { type: "error", message: "Invalid resume envelope" };
      }

      return value as ConnectEnvelope;
    }

    if (value.type === "input") {
      if (typeof value.viewId !== "string" || !isInputPayload(value.input)) {
        return { type: "error", message: "Invalid input envelope" };
      }

      if (value.clientInputId !== undefined && typeof value.clientInputId !== "string") {
        return { type: "error", message: "Invalid client input id" };
      }

      return value as ClientInputEnvelope<TInput>;
    }

    return { type: "error", message: "Unknown envelope type" };
  } catch {
    return { type: "error", message: "Malformed JSON envelope" };
  }
}

function isInputPayload(value: unknown): value is { type: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function isResume(value: unknown): value is ConnectEnvelope["resume"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const resume = value as Record<string, unknown>;
  return typeof resume.viewId === "string" && typeof resume.cursor === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
