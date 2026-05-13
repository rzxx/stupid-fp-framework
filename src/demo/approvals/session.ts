import { Schema, Session, type SessionDefinition } from "../../framework";
import type { ApprovalSessionMessage, ApprovalSessionState } from "./types";

export const approvalSession: SessionDefinition<ApprovalSessionState, ApprovalSessionMessage> =
  Session.define<ApprovalSessionState, ApprovalSessionMessage>({
    init: () => ({
      selectedDeploymentId: null,
      tracePanelOpen: true,
    }),
    messages: [
      {
        type: "session.selectDeployment",
        schema: Schema.Struct({
          type: Schema.Literal("session.selectDeployment"),
          deploymentId: Schema.String,
        }),
        update: (
          state,
          message: Extract<ApprovalSessionMessage, { type: "session.selectDeployment" }>,
        ) => ({
          ...state,
          selectedDeploymentId: message.deploymentId,
        }),
      },
      {
        type: "session.toggleTracePanel",
        schema: Schema.Struct({
          type: Schema.Literal("session.toggleTracePanel"),
        }),
        update: (state) => ({
          ...state,
          tracePanelOpen: !state.tracePanelOpen,
        }),
      },
    ],
  });
