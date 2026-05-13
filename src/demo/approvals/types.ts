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

export type ApprovalProjection = {
  route: "/teams/:teamId/deployments";
  team: { id: string; name: string };
  currentUser: { id: string; name: string; role: "approver" | "viewer" };
  pendingDeployments: DeploymentSummary[];
  selectedDeployment: DeploymentDetail | null;
  tracePanelOpen: boolean;
  traces: TraceSnapshot[];
};

export type ApprovalSessionState = {
  selectedDeploymentId: string | null;
  tracePanelOpen: boolean;
};

export type ApprovalSessionMessage =
  | { type: "session.selectDeployment"; deploymentId: string }
  | { type: "session.toggleTracePanel" };

export type ApprovalActionMessage = {
  type: "action.approveDeployment";
  deploymentId: string;
};

export type ApprovalClientMessage = ApprovalSessionMessage | ApprovalActionMessage;
