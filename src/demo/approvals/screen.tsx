import { Effect, type ProjectionContext, type ScreenDefinition } from "../../framework";
import { AuditTrail, Deployment, PendingDeployments } from "./resources";
import { Auth, Teams, type ApprovalEnvironment } from "./services";
import type {
  ApprovalProjection,
  ApprovalSessionState,
  AuditEntry,
  Deployment as DeploymentRecord,
  DeploymentDetail,
  DeploymentSummary,
} from "./types";

export const approvalScreen: ScreenDefinition<
  ApprovalEnvironment,
  ApprovalSessionState,
  ApprovalProjection
> = {
  route: "/teams/:teamId/deployments",
  project(session, context) {
    return Effect.gen(function* () {
      const teamId = session.params.teamId;
      const teams = yield* Teams;
      const auth = yield* Auth;
      const team = teams.find(teamId);
      const currentUser = auth.currentUser();
      const pendingDeployments = yield* context.region("pendingDeployments", () =>
        Effect.map(context.resources.read(PendingDeployments(teamId)), (deployments) =>
          deployments.map(summary),
        ),
      );
      const selectedDeployment = session.state.selectedDeploymentId
        ? yield* context.region("selectedDeployment", () =>
            selectedDetail(session.state.selectedDeploymentId as string, context),
          )
        : null;

      const tracePanel = yield* context.region("tracePanel", () =>
        Effect.succeed({
          open: session.state.tracePanelOpen,
          traces: context.traces.list(),
        }),
      );

      return {
        route: "/teams/:teamId/deployments",
        team,
        currentUser: {
          id: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
        },
        pendingDeployments,
        selectedDeployment,
        tracePanelOpen: tracePanel.open,
        traces: tracePanel.traces,
      };
    });
  },
};

function selectedDetail(deploymentId: string, context: ProjectionContext<ApprovalEnvironment>) {
  return Effect.gen(function* () {
    const deployment = yield* context.resources.read(Deployment(deploymentId));

    if (!deployment) {
      return null;
    }

    const auditTrail = yield* context.resources.read(AuditTrail(deploymentId));

    return detail(deployment, auditTrail);
  });
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
