import type { ScreenDefinition } from "../../framework";
import { AuditTrail, Deployment, PendingDeployments } from "./resources";
import type { ApprovalServices } from "./services";
import type {
  ApprovalProjection,
  ApprovalSessionState,
  AuditEntry,
  Deployment as DeploymentRecord,
  DeploymentDetail,
  DeploymentSummary,
} from "./types";

export const approvalScreen: ScreenDefinition<
  ApprovalServices,
  ApprovalSessionState,
  ApprovalProjection
> = {
  route: "/teams/:teamId/deployments",
  async project(session, context) {
    const teamId = session.params.teamId;
    const team = context.services.teams.find(teamId);
    const currentUser = context.services.auth.currentUser();
    const pending = await context.resources.read(context.services, PendingDeployments(teamId));
    const selectedDeployment = session.state.selectedDeploymentId
      ? await selectedDetail(session.state.selectedDeploymentId, context)
      : null;

    return {
      route: "/teams/:teamId/deployments",
      team,
      currentUser: {
        id: currentUser.id,
        name: currentUser.name,
        role: currentUser.role,
      },
      pendingDeployments: pending.map(summary),
      selectedDeployment,
      tracePanelOpen: session.state.tracePanelOpen,
      traces: context.traces.list(),
    };
  },
};

async function selectedDetail(
  deploymentId: string,
  context: Parameters<typeof approvalScreen.project>[1],
): Promise<DeploymentDetail | null> {
  const deployment = await context.resources.read(context.services, Deployment(deploymentId));

  if (!deployment) {
    return null;
  }

  const auditTrail = await context.resources.read(context.services, AuditTrail(deploymentId));

  return detail(deployment, auditTrail);
}

function summary(deployment: DeploymentRecord): DeploymentSummary {
  return {
    id: deployment.id,
    service: deployment.service,
    version: deployment.version,
    environment: deployment.environment,
    requestedBy: deployment.requestedBy,
    requestedAt: deployment.requestedAt,
  };
}

function detail(deployment: DeploymentRecord, auditTrail: AuditEntry[]): DeploymentDetail {
  return {
    ...summary(deployment),
    status: deployment.status,
    auditTrail,
  };
}
