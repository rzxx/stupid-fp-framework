import type {
  ActionResultEnvelope,
  ErrorEnvelope,
  ProjectionEnvelope,
  TraceEnvelope,
} from "../framework";
import type { ApprovalClientMessage, ApprovalProjection } from "../demo/approvals/types";
import { connectProgramStream, type ConnectionState } from "./program-stream";

export type { ConnectionState } from "./program-stream";

export type ApprovalStreamHandlers = {
  onConnectionState: (state: ConnectionState) => void;
  onSession: (sessionId: string, resumed: boolean) => void;
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
  return connectProgramStream<
    ApprovalClientMessage,
    ApprovalProjection,
    ApprovalProjection["traces"][number]
  >({
    route: "/teams/:teamId/deployments",
    params: { teamId: "team-platform" },
    storageKey: "approval-stream",
    handlers,
  });
}
