import { createRuntime, defineProgram, type RuntimeStore } from "../../framework";
import { approvalActions } from "./actions";
import { approvalResources } from "./resources";
import { approvalScreen } from "./screen";
import {
  createApprovalLayer,
  createApprovalServices,
  type ApprovalEnvironment,
  type ApprovalServices,
} from "./services";
import { approvalSession } from "./session";
import type {
  ApprovalActionMessage,
  ApprovalProjection,
  ApprovalUIEvent,
  ApprovalUIState,
} from "./types";

export function createApprovalProgram(options?: {
  services?: ApprovalServices;
  currentUserId?: string;
}) {
  const services =
    options?.services ?? createApprovalServices({ currentUserId: options?.currentUserId });

  return defineProgram<
    ApprovalEnvironment,
    ApprovalUIState,
    ApprovalUIEvent,
    ApprovalActionMessage,
    ApprovalProjection
  >({
    layer: createApprovalLayer(services),
    resources: approvalResources,
    uiState: approvalSession,
    screen: approvalScreen,
    actions: approvalActions,
  });
}

export function createApprovalRuntime(options?: {
  services?: ApprovalServices;
  currentUserId?: string;
  store?: RuntimeStore<ApprovalUIState, ApprovalProjection>;
}) {
  return createRuntime(createApprovalProgram(options), { store: options?.store });
}
