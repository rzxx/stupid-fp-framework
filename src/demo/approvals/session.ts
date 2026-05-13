import type { SessionDefinition } from "../../framework";
import type { ApprovalSessionMessage, ApprovalSessionState } from "./types";

export const approvalSession: SessionDefinition<ApprovalSessionState, ApprovalSessionMessage> = {
  init: () => ({
    selectedDeploymentId: null,
    tracePanelOpen: true,
  }),
  accepts(message): message is ApprovalSessionMessage {
    return (
      isMessage(message) &&
      (message.type === "session.selectDeployment" || message.type === "session.toggleTracePanel")
    );
  },
  update(state, message) {
    if (message.type === "session.selectDeployment") {
      return {
        ...state,
        selectedDeploymentId: message.deploymentId,
      };
    }

    return {
      ...state,
      tracePanelOpen: !state.tracePanelOpen,
    };
  },
};

function isMessage(value: unknown): value is { type: string } {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
