import type {
  ActionResultEnvelope,
  ErrorEnvelope,
  ProjectionEnvelope,
  ResumeResult,
  TraceEnvelope,
} from "../../../framework";
import type { ApprovalClientMessage, ApprovalProjection } from "../types";
import { connectProgramStream, type ConnectionState } from "../../../adapters/react";

export type { ConnectionState } from "../../../adapters/react";

export type ApprovalStreamHandlers = {
  onConnectionState: (state: ConnectionState) => void;
  onSession: (sessionId: string, resumed: boolean, resume: ResumeResult) => void;
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
