import type {
  ActionResultEnvelope,
  ClientEnvelope,
  ErrorEnvelope,
  ProjectionPatchEnvelope,
  ProjectionEnvelope,
  ServerEnvelope,
  TraceEnvelope,
} from "../framework";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export type ProgramStreamHandlers<TProjection, TTrace> = {
  onConnectionState: (state: ConnectionState) => void;
  onSession: (sessionId: string, resumed: boolean) => void;
  onProjection: (envelope: ProjectionEnvelope<TProjection>) => void;
  onPatch?: (envelope: ProjectionPatchEnvelope) => void;
  onTrace: (envelope: TraceEnvelope<TTrace>) => void;
  onActionResult: (envelope: ActionResultEnvelope) => void;
  onError: (envelope: ErrorEnvelope) => void;
};

export type ProgramStreamOptions<TProjection, TTrace> = {
  route: string;
  params: Record<string, string>;
  storageKey?: string;
  handlers: ProgramStreamHandlers<TProjection, TTrace>;
};

export type ProgramStreamClient<TMessage> = {
  send: (message: TMessage) => void;
  close: () => void;
};

type ResumeState = {
  sessionId: string;
  cursor: string;
};

export function connectProgramStream<TMessage, TProjection, TTrace>(
  options: ProgramStreamOptions<TProjection, TTrace>,
): ProgramStreamClient<TMessage> {
  const socket = new WebSocket(streamUrl());
  let sessionId: string | null = null;

  options.handlers.onConnectionState("connecting");

  socket.addEventListener("open", () => {
    options.handlers.onConnectionState("open");
    const resume = readResume(options.storageKey);
    sendEnvelope<TMessage>(socket, {
      type: "connect",
      route: options.route,
      params: options.params,
      resume,
    });
  });

  socket.addEventListener("close", () => {
    options.handlers.onConnectionState("closed");
  });

  socket.addEventListener("error", () => {
    options.handlers.onConnectionState("error");
  });

  socket.addEventListener("message", (event) => {
    const envelope = JSON.parse(String(event.data)) as ServerEnvelope<TProjection, TTrace>;

    persistCursor(options.storageKey, envelope);

    if (envelope.type === "connected") {
      sessionId = envelope.sessionId;
      options.handlers.onSession(envelope.sessionId, envelope.resumed);
      return;
    }

    if (envelope.type === "projection:update") {
      options.handlers.onProjection(envelope);
      return;
    }

    if (envelope.type === "projection:patch") {
      options.handlers.onPatch?.(envelope);
      return;
    }

    if (envelope.type === "trace:update") {
      options.handlers.onTrace(envelope);
      return;
    }

    if (envelope.type === "action:result") {
      options.handlers.onActionResult(envelope);
      return;
    }

    options.handlers.onError(envelope);
  });

  return {
    send(message) {
      if (!sessionId) {
        options.handlers.onError({
          type: "error",
          message: "Cannot send before session is connected",
        });
        return;
      }

      sendEnvelope(socket, { type: "message", sessionId, message });
    },
    close() {
      socket.close();
    },
  };
}

function sendEnvelope<TMessage>(socket: WebSocket, envelope: ClientEnvelope<TMessage>): void {
  socket.send(JSON.stringify(envelope));
}

function streamUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/stream`;
}

function readResume(storageKey: string | undefined): ResumeState | undefined {
  if (!storageKey) {
    return undefined;
  }

  const value = window.sessionStorage.getItem(storageKey);

  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as ResumeState;
    return typeof parsed.sessionId === "string" && typeof parsed.cursor === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function persistCursor<TProjection, TTrace>(
  storageKey: string | undefined,
  envelope: ServerEnvelope<TProjection, TTrace>,
): void {
  if (!storageKey || !("cursor" in envelope) || !envelope.sessionId) {
    return;
  }

  window.sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      sessionId: envelope.sessionId,
      cursor: envelope.cursor,
    }),
  );
}
