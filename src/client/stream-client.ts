import type {
  ActionResultEnvelope,
  ClientEnvelope,
  ErrorEnvelope,
  ProjectionEnvelope,
  ServerEnvelope,
  TraceEnvelope,
} from "../framework";
import type { ApprovalClientMessage, ApprovalProjection } from "../demo/approvals/types";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export type ApprovalStreamHandlers = {
  onConnectionState: (state: ConnectionState) => void;
  onSession: (sessionId: string) => void;
  onProjection: (envelope: ProjectionEnvelope<ApprovalProjection>) => void;
  onTrace: (envelope: TraceEnvelope<ApprovalProjection["traces"][number]>) => void;
  onActionResult: (envelope: ActionResultEnvelope) => void;
  onError: (envelope: ErrorEnvelope) => void;
};

export type ApprovalStreamClient = {
  send: (message: ApprovalClientMessage) => void;
  close: () => void;
};

export function connectApprovalStream(handlers: ApprovalStreamHandlers): ApprovalStreamClient {
  const socket = new WebSocket(streamUrl());
  let sessionId: string | null = null;

  handlers.onConnectionState("connecting");

  socket.addEventListener("open", () => {
    handlers.onConnectionState("open");
    sendEnvelope(socket, {
      type: "connect",
      route: "/teams/:teamId/deployments",
      params: { teamId: "team-platform" },
    });
  });

  socket.addEventListener("close", () => {
    handlers.onConnectionState("closed");
  });

  socket.addEventListener("error", () => {
    handlers.onConnectionState("error");
  });

  socket.addEventListener("message", (event) => {
    const envelope = JSON.parse(String(event.data)) as ServerEnvelope<
      ApprovalProjection,
      ApprovalProjection["traces"][number]
    >;

    if (envelope.type === "connected") {
      sessionId = envelope.sessionId;
      handlers.onSession(envelope.sessionId);
      return;
    }

    if (envelope.type === "projection:update") {
      handlers.onProjection(envelope);
      return;
    }

    if (envelope.type === "trace:update") {
      handlers.onTrace(envelope);
      return;
    }

    if (envelope.type === "action:result") {
      handlers.onActionResult(envelope);
      return;
    }

    handlers.onError(envelope);
  });

  return {
    send(message) {
      if (!sessionId) {
        handlers.onError({
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

function sendEnvelope(socket: WebSocket, envelope: ClientEnvelope<ApprovalClientMessage>): void {
  socket.send(JSON.stringify(envelope));
}

function streamUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/stream`;
}
