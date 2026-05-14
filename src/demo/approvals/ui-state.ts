import { Schema, UIState, type UIStateDefinition } from "../../framework";
import type { ApprovalUIEvent, ApprovalUIState } from "./types";

export const approvalUIState: UIStateDefinition<ApprovalUIState, ApprovalUIEvent> = UIState.define<
  ApprovalUIState,
  ApprovalUIEvent
>({
  init: () => ({
    selectedDeploymentId: null,
    tracePanelOpen: true,
  }),
  events: [
    {
      type: "ui.deployment.select",
      schema: Schema.Struct({
        type: Schema.Literal("ui.deployment.select"),
        deploymentId: Schema.String,
      }),
      update: (state, event: Extract<ApprovalUIEvent, { type: "ui.deployment.select" }>) => ({
        ...state,
        selectedDeploymentId: event.deploymentId,
      }),
    },
    {
      type: "ui.trace.toggle",
      schema: Schema.Struct({
        type: Schema.Literal("ui.trace.toggle"),
      }),
      update: (state) => ({
        ...state,
        tracePanelOpen: !state.tracePanelOpen,
      }),
    },
  ],
});
