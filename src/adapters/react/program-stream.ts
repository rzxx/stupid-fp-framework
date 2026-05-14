import type {
  ActionResultEnvelope,
  ClientEnvelope,
  ErrorEnvelope,
  ProgramStreamBootstrap,
  ProjectionPatchEnvelope,
  ProjectionEnvelope,
  ResumeResult,
  ServerEnvelope,
  TraceEnvelope,
} from "../../framework";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export type ProgramStreamHandlers<TProjection, TTrace> = {
  onConnectionState: (state: ConnectionState) => void;
  onView: (viewId: string, resumed: boolean, resume: ResumeResult) => void;
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
  bootstrap?: ProgramStreamBootstrap<TProjection, TTrace>;
  handlers: ProgramStreamHandlers<TProjection, TTrace>;
  environment?: ProgramStreamEnvironment;
};

export type ProgramStreamClient<TInput> = {
  send: (input: TInput) => void;
  close: () => void;
};

export type ProgramStreamEnvironment = {
  createSocket?: (url: string) => ProgramStreamSocket;
  storage?: ProgramStreamStorage;
  streamUrl?: string;
};

export type ProgramStreamSocket = Pick<WebSocket, "addEventListener" | "close" | "send">;

export type ProgramStreamStorage = Pick<Storage, "getItem" | "setItem">;

type ResumeState = {
  viewId: string;
  cursor: string;
};

export function connectProgramStream<TInput, TProjection, TTrace>(
  options: ProgramStreamOptions<TProjection, TTrace>,
): ProgramStreamClient<TInput> {
  const url = options.environment?.streamUrl ?? streamUrl();
  const socket = options.environment?.createSocket?.(url) ?? new WebSocket(url);
  let viewId: string | null = null;

  options.handlers.onConnectionState("connecting");

  socket.addEventListener("open", () => {
    options.handlers.onConnectionState("open");
    const resume =
      options.bootstrap ?? readResume(options.storageKey, options.environment?.storage);
    sendEnvelope<TInput>(socket, {
      type: "connect",
      route: options.route,
      params: options.params,
      resume: resume
        ? {
            viewId: resume.viewId,
            cursor: resume.cursor,
          }
        : undefined,
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

    persistCursor(options.storageKey, envelope, options.environment?.storage);

    if (envelope.type === "connected") {
      viewId = envelope.viewId;
      options.handlers.onView(envelope.viewId, envelope.resumed, envelope.resume);
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
    send(input) {
      if (!viewId) {
        options.handlers.onError({
          type: "error",
          message: "Cannot send before view is connected",
        });
        return;
      }

      sendEnvelope(socket, { type: "input", viewId, input });
    },
    close() {
      socket.close();
    },
  };
}

function sendEnvelope<TInput>(socket: ProgramStreamSocket, envelope: ClientEnvelope<TInput>): void {
  socket.send(JSON.stringify(envelope));
}

function streamUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/stream`;
}

function readResume(
  storageKey: string | undefined,
  storage: ProgramStreamStorage = window.sessionStorage,
): ResumeState | undefined {
  if (!storageKey) {
    return undefined;
  }

  const value = storage.getItem(storageKey);

  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as ResumeState;
    return typeof parsed.viewId === "string" && typeof parsed.cursor === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function persistCursor<TProjection, TTrace>(
  storageKey: string | undefined,
  envelope: ServerEnvelope<TProjection, TTrace>,
  storage: ProgramStreamStorage = window.sessionStorage,
): void {
  if (!storageKey || !("cursor" in envelope) || !envelope.viewId) {
    return;
  }

  storage.setItem(
    storageKey,
    JSON.stringify({
      viewId: envelope.viewId,
      cursor: envelope.cursor,
    }),
  );
}
