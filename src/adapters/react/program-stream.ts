import type {
  ActionResultEnvelope,
  ActionLifecycleEnvelope,
  ClientEnvelope,
  ErrorEnvelope,
  ProgramStreamBootstrap,
  ProjectionPatchEnvelope,
  ProjectionEnvelope,
  ResumeResult,
  ServerEnvelope,
  TraceEnvelope,
} from "../../framework/stream";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export type ProgramStreamHandlers<TProjection, TTrace> = {
  onConnectionState: (state: ConnectionState) => void;
  onView: (viewId: string, resumed: boolean, resume: ResumeResult) => void;
  onProjection: (envelope: ProjectionEnvelope<TProjection>) => void;
  onPatch?: (envelope: ProjectionPatchEnvelope) => void;
  onTrace: (envelope: TraceEnvelope<TTrace>) => void;
  onActionLifecycle: (envelope: ActionLifecycleEnvelope) => void;
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
  reconnect?: ProgramStreamReconnectOptions;
};

export type ProgramStreamClient<TInput> = {
  send: (input: TInput) => string | undefined;
  navigate: (
    path: string,
    options?: {
      params?: Record<string, string>;
      navigation?: "push" | "replace" | "pop" | "hash";
    },
  ) => string | undefined;
  close: () => void;
};

export type ProgramStreamEnvironment = {
  createSocket?: (url: string) => ProgramStreamSocket;
  createClientInputId?: () => string;
  storage?: ProgramStreamStorage;
  streamUrl?: string;
  timers?: ProgramStreamTimers;
};

export type ProgramStreamSocket = Pick<WebSocket, "addEventListener" | "close" | "send">;

export type ProgramStreamStorage = Pick<Storage, "getItem" | "setItem">;

export type ProgramStreamTimers = {
  setTimeout: (handler: () => void, timeout: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export type ProgramStreamReconnectOptions = {
  enabled?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
};

type ResumeState = {
  viewId: string;
  cursor: string;
};

export function connectProgramStream<TInput, TProjection, TTrace>(
  options: ProgramStreamOptions<TProjection, TTrace>,
): ProgramStreamClient<TInput> {
  const url = options.environment?.streamUrl ?? streamUrl();
  const timers: ProgramStreamTimers = options.environment?.timers ?? {
    setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  };
  const reconnect = {
    enabled: options.reconnect?.enabled ?? true,
    baseDelayMs: options.reconnect?.baseDelayMs ?? 250,
    maxDelayMs: options.reconnect?.maxDelayMs ?? 5000,
    jitter: options.reconnect?.jitter ?? true,
  };
  let socket: ProgramStreamSocket | null = null;
  let viewId: string | null = null;
  let connected = false;
  let manuallyClosed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown = null;
  let connectRoute = {
    route: options.route,
    params: options.params,
  };

  options.handlers.onConnectionState("connecting");
  openSocket();

  return {
    send(input) {
      if (!viewId || !socket || !connected) {
        options.handlers.onError({
          type: "error",
          message: connected
            ? "Cannot send before view is connected"
            : "Cannot send while stream is disconnected",
        });
        return undefined;
      }

      const clientInputId = createClientInputId(options.environment);
      sendEnvelope(socket, { type: "input", viewId, clientInputId, input });
      return clientInputId;
    },
    navigate(path, navigateOptions) {
      connectRoute = {
        route: path,
        params: navigateOptions?.params ?? {},
      };

      return this.send({
        type: "system.navigate",
        path,
        params: navigateOptions?.params,
        navigation: navigateOptions?.navigation ?? "push",
      } as TInput);
    },
    close() {
      manuallyClosed = true;
      connected = false;

      if (reconnectTimer !== null) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      socket?.close();
    },
  };

  function openSocket(): void {
    socket = options.environment?.createSocket?.(url) ?? new WebSocket(url);

    socket.addEventListener("open", () => {
      connected = true;
      reconnectAttempt = 0;
      options.handlers.onConnectionState("open");
      const resume =
        options.bootstrap ?? readResume(options.storageKey, options.environment?.storage);

      sendEnvelope<TInput>(socket as ProgramStreamSocket, {
        type: "connect",
        route: connectRoute.route,
        params: connectRoute.params,
        resume: resume
          ? {
              viewId: resume.viewId,
              cursor: resume.cursor,
            }
          : undefined,
      });
    });

    socket.addEventListener("close", () => {
      connected = false;
      options.handlers.onConnectionState("closed");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      connected = false;
      options.handlers.onConnectionState("error");
      scheduleReconnect();
    });

    socket.addEventListener("message", (event) => {
      let envelope: ServerEnvelope<TProjection, TTrace>;

      try {
        envelope = JSON.parse(String(event.data)) as ServerEnvelope<TProjection, TTrace>;
      } catch {
        options.handlers.onError({
          type: "error",
          message: "Malformed server envelope",
        });
        return;
      }

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

      if (envelope.type === "action:lifecycle") {
        options.handlers.onActionLifecycle(envelope);
        return;
      }

      if (envelope.type === "action:result") {
        options.handlers.onActionResult(envelope);
        return;
      }

      options.handlers.onError(envelope);
    });
  }

  function scheduleReconnect(): void {
    if (manuallyClosed || !reconnect.enabled || reconnectTimer !== null) {
      return;
    }

    reconnectAttempt += 1;
    const capped = Math.min(
      reconnect.maxDelayMs,
      reconnect.baseDelayMs * 2 ** Math.max(0, reconnectAttempt - 1),
    );
    const delay = reconnect.jitter ? Math.round(capped * (0.8 + Math.random() * 0.4)) : capped;

    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      options.handlers.onConnectionState("connecting");
      openSocket();
    }, delay);
  }
}

function sendEnvelope<TInput>(socket: ProgramStreamSocket, envelope: ClientEnvelope<TInput>): void {
  socket.send(JSON.stringify(envelope));
}

function streamUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/stream`;
}

function createClientInputId(environment?: ProgramStreamEnvironment): string {
  return environment?.createClientInputId?.() ?? `input-${crypto.randomUUID()}`;
}

function readResume(
  storageKey: string | undefined,
  storage?: ProgramStreamStorage,
): ResumeState | undefined {
  if (!storageKey) {
    return undefined;
  }

  const resolvedStorage = storage ?? browserSessionStorage();

  if (!resolvedStorage) {
    return undefined;
  }

  const value = resolvedStorage.getItem(storageKey);

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
  storage?: ProgramStreamStorage,
): void {
  if (!storageKey || !("cursor" in envelope) || !envelope.viewId) {
    return;
  }

  const resolvedStorage = storage ?? browserSessionStorage();

  if (!resolvedStorage) {
    return;
  }

  resolvedStorage.setItem(
    storageKey,
    JSON.stringify({
      viewId: envelope.viewId,
      cursor: envelope.cursor,
    }),
  );
}

function browserSessionStorage(): ProgramStreamStorage | undefined {
  return typeof window === "undefined" ? undefined : window.sessionStorage;
}
