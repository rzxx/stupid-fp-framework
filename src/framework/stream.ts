export type ConnectEnvelope = {
  type: "connect";
  route: string;
  params: Record<string, string>;
  resume?: {
    sessionId: string;
    cursor: string;
  };
};

export type ClientMessageEnvelope<TMessage> = {
  type: "message";
  sessionId: string;
  message: TMessage;
};

export type ClientEnvelope<TMessage> = ConnectEnvelope | ClientMessageEnvelope<TMessage>;

export type ConnectedEnvelope = {
  type: "connected";
  sessionId: string;
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
      reason: "missing-session" | "route-mismatch";
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
  sessionId: string;
  cursor: string;
  projectionVersion: number;
  projection: TProjection;
  regions: {
    id: string;
    resources: {
      type: string;
      id: string;
      label: string;
    }[];
  }[];
  causedByTraceId?: string;
};

export type ActionResultEnvelope = {
  type: "action:result";
  sessionId: string;
  cursor: string;
  traceId: string;
  action: string;
  ok: boolean;
  error?: string;
};

export type TraceEnvelope<TTrace> = {
  type: "trace:update";
  sessionId: string;
  cursor: string;
  trace: TTrace;
};

export type ErrorEnvelope = {
  type: "error";
  sessionId?: string;
  traceId?: string;
  message: string;
};

export type ServerEnvelope<TProjection, TTrace> =
  | ConnectedEnvelope
  | ProjectionEnvelope<TProjection>
  | ActionResultEnvelope
  | TraceEnvelope<TTrace>
  | ErrorEnvelope;

export function parseClientEnvelope<TMessage>(
  payload: string,
): ClientEnvelope<TMessage> | ErrorEnvelope {
  try {
    const value = JSON.parse(payload) as Partial<ClientEnvelope<TMessage>>;

    if (value.type === "connect") {
      if (typeof value.route !== "string" || !isStringRecord(value.params)) {
        return { type: "error", message: "Invalid connect envelope" };
      }

      if (value.resume !== undefined && !isResume(value.resume)) {
        return { type: "error", message: "Invalid resume envelope" };
      }

      return value as ConnectEnvelope;
    }

    if (value.type === "message") {
      if (!value.sessionId || !value.message) {
        return { type: "error", message: "Invalid message envelope" };
      }

      return value as ClientMessageEnvelope<TMessage>;
    }

    return { type: "error", message: "Unknown envelope type" };
  } catch {
    return { type: "error", message: "Malformed JSON envelope" };
  }
}

function isResume(value: unknown): value is ConnectEnvelope["resume"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const resume = value as Record<string, unknown>;
  return typeof resume.sessionId === "string" && typeof resume.cursor === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
