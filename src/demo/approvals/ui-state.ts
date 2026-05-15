import { Schema, UIState, type UIStateDefinition } from "../../framework";
import type { ApprovalUIEvent, ApprovalUIState } from "./types";

export const approvalUIState: UIStateDefinition<ApprovalUIState, ApprovalUIEvent> = UIState.define(
  "approval.ui",
)
  .init<ApprovalUIState>(() => ({
    selectedDeploymentId: null,
    tracePanelOpen: true,
  }))
  .event<Extract<ApprovalUIEvent, { type: "ui.deployment.select" }>>(
    "ui.deployment.select",
    Schema.Struct({
      type: Schema.Literal("ui.deployment.select"),
      deploymentId: Schema.String,
    }),
    (state, event) => ({
      ...state,
      selectedDeploymentId: event.deploymentId,
    }),
  )
  .event<Extract<ApprovalUIEvent, { type: "ui.trace.toggle" }>>(
    "ui.trace.toggle",
    Schema.Struct({
      type: Schema.Literal("ui.trace.toggle"),
    }),
    (state) => ({
      ...state,
      tracePanelOpen: !state.tracePanelOpen,
    }),
  )
  .build();
