import type {
  ActionResultEnvelope,
  ActionLifecycleEnvelope,
  ErrorEnvelope,
  ProjectionEnvelope,
  ResumeResult,
  TraceEnvelope,
} from "../../../framework";
import type { ApprovalClientInput, ApprovalProjection } from "../types";
import { connectProgramStream, type ConnectionState } from "../../../adapters/react";

export type { ConnectionState } from "../../../adapters/react";

export type ApprovalStreamHandlers = {
  onConnectionState: (state: ConnectionState) => void;
  onView: (viewId: string, resumed: boolean, resume: ResumeResult) => void;
  onProjection: (envelope: ProjectionEnvelope<ApprovalProjection>) => void;
  onTrace: (envelope: TraceEnvelope<ApprovalProjection["traces"][number]>) => void;
  onActionLifecycle: (envelope: ActionLifecycleEnvelope) => void;
  onActionResult: (envelope: ActionResultEnvelope) => void;
  onError: (envelope: ErrorEnvelope) => void;
};

export type ApprovalStreamClient = {
  send: (input: ApprovalClientInput) => string | undefined;
  close: () => void;
};

export function connectApprovalStream(handlers: ApprovalStreamHandlers): ApprovalStreamClient {
  return connectProgramStream<
    ApprovalClientInput,
    ApprovalProjection,
    ApprovalProjection["traces"][number]
  >({
    route: "/teams/:teamId/deployments",
    params: { teamId: "team-platform" },
    storageKey: "approval-stream",
    handlers,
  });
}
