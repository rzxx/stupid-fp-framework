import { createRuntime, defineProgram } from "../../framework";
import { approvalActions } from "./actions";
import { approvalResources } from "./resources";
import { approvalScreen } from "./screen";
import { createApprovalServices, type ApprovalServices } from "./services";
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
    ApprovalServices,
    ApprovalSessionState,
    ApprovalSessionMessage,
    ApprovalActionMessage,
    ApprovalProjection
  >({
    services,
    resources: approvalResources,
    session: approvalSession,
    screen: approvalScreen,
    actions: approvalActions,
  });
}

export function createApprovalRuntime(options?: {
  services?: ApprovalServices;
  currentUserId?: string;
}) {
  return createRuntime(createApprovalProgram(options));
}
