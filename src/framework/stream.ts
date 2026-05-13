export type ConnectEnvelope = {
  type: "connect";
  route: "/teams/:teamId/deployments";
  params: { teamId: string };
  resumeCursor?: string;
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
};

export type ProjectionEnvelope<TProjection> = {
  type: "projection:update";
  sessionId: string;
  projectionVersion: number;
  projection: TProjection;
};

export type ActionResultEnvelope = {
  type: "action:result";
  sessionId: string;
  traceId: string;
  action: string;
  ok: boolean;
  error?: string;
};

export type TraceEnvelope<TTrace> = {
  type: "trace:update";
  sessionId: string;
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
      if (value.route !== "/teams/:teamId/deployments" || !value.params?.teamId) {
        return { type: "error", message: "Invalid connect envelope" };
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
