import type { TraceSnapshot } from "../../framework";

export type Team = {
  id: string;
  name: string;
};

export type User = {
  id: string;
  name: string;
  role: "approver" | "viewer";
  teamIds: string[];
};

export type Deployment = {
  id: string;
  teamId: string;
  service: string;
  version: string;
  environment: "staging" | "production";
  status: "pending" | "approved" | "rejected";
  requestedBy: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
};

export type DeploymentRun = {
  id: string;
  teamId: string;
  label: string;
  status: "queued" | "running" | "healthy" | "blocked";
  progress: number;
  updatedAt: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  actorId: string;
  event: "deployment.approval_requested" | "deployment.approved" | "deployment.approval_denied";
  deploymentId: string;
  detail: Record<string, unknown>;
};

export type DeploymentSummary = {
  id: string;
  service: string;
  version: string;
  environment: string;
  requestedBy: string;
  requestedAt: string;
};

export type DeploymentDetail = DeploymentSummary & {
  status: "pending" | "approved" | "rejected";
  auditTrail: AuditEntry[];
};

export type DeploymentRunSummary = {
  id: string;
  label: string;
  status: "queued" | "running" | "healthy" | "blocked";
  progress: number;
  updatedAt: string;
};

export type ApprovalRoute = "/teams/:teamId/deployments" | "/teams/:teamId/runs";

export type ApprovalProjection = {
  route: ApprovalRoute;
  page: "deployments" | "runs";
  team: { id: string; name: string };
  currentUser: { id: string; name: string; role: "approver" | "viewer" };
  navigation: {
    deploymentsPath: string;
    runsPath: string;
  };
  pendingDeployments: DeploymentSummary[];
  selectedDeployment: DeploymentDetail | null;
  activeRuns: DeploymentRunSummary[];
  deploymentFilter: string;
  tracePanelOpen: boolean;
  traces: TraceSnapshot[];
};

export type ApprovalUIState = {
  selectedDeploymentId: string | null;
  deploymentFilter: string;
  tracePanelOpen: boolean;
};

export type ApprovalUIEvent =
  | { type: "ui.deployment.select"; deploymentId: string }
  | { type: "ui.deployment.filter"; value: string }
  | { type: "ui.trace.toggle" };

export type ApprovalActionInput = {
  type: "action.approveDeployment";
  deploymentId: string;
};

export type ApprovalSystemInput = {
  type: "system.navigate";
  path: string;
  params?: Record<string, string>;
  navigation?: "push" | "replace" | "pop" | "hash";
};

export type ApprovalClientInput = ApprovalUIEvent | ApprovalActionInput | ApprovalSystemInput;
