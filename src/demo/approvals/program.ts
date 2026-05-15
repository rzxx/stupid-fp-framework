import { createRuntime, Program, type RuntimeStore } from "../../framework";
import { approvalActions } from "./actions";
import { approvalResources } from "./resources";
import { approvalScreens } from "./screen";
import {
  createApprovalLayer,
  createApprovalServices,
  type ApprovalEnvironment,
  type ApprovalServices,
} from "./services";
import { approvalUIState } from "./ui-state";
import type {
  ApprovalActionInput,
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

  return Program.define("approvals")
    .layer<ApprovalEnvironment>(createApprovalLayer(services))
    .resources(...approvalResources)
    .ui<ApprovalUIState, ApprovalUIEvent>(approvalUIState)
    .screens<ApprovalProjection>(...approvalScreens)
    .actions<ApprovalActionInput>(...approvalActions)
    .build();
}

export function createApprovalRuntime(options?: {
  services?: ApprovalServices;
  currentUserId?: string;
  store?: RuntimeStore<ApprovalUIState, ApprovalProjection>;
}) {
  return createRuntime(createApprovalProgram(options), { store: options?.store });
}
