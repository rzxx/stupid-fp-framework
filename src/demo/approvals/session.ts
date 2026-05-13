import type { SessionDefinition } from "../../framework";
import type { ApprovalSessionMessage, ApprovalSessionState } from "./types";

export const approvalSession: SessionDefinition<ApprovalSessionState, ApprovalSessionMessage> = {
  init: () => ({
    selectedDeploymentId: null,
    tracePanelOpen: true,
  }),
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
