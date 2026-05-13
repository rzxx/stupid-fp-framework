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
  ApprovalSessionMessage,
  ApprovalSessionState,
} from "./types";

export function createApprovalProgram(options?: {
  services?: ApprovalServices;
  currentUserId?: string;
}) {
  const services =
    options?.services ?? createApprovalServices({ currentUserId: options?.currentUserId });

  return defineProgram<
    ApprovalEnvironment,
    ApprovalSessionState,
    ApprovalSessionMessage,
    ApprovalActionMessage,
    ApprovalProjection
  >({
    layer: createApprovalLayer(services),
    resources: approvalResources,
    session: approvalSession,
    screen: approvalScreen,
    actions: approvalActions,
  });
}

export function createApprovalRuntime(options?: {
  services?: ApprovalServices;
  currentUserId?: string;
  store?: RuntimeStore<ApprovalSessionState, ApprovalProjection>;
}) {
  return createRuntime(createApprovalProgram(options), { store: options?.store });
}
