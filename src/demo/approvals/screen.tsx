import {
  Effect,
  Route,
  Schema,
  type ProjectionContext,
  type ScreenDefinition,
} from "../../framework";
import { ActiveDeploymentRuns, AuditTrail, Deployment, PendingDeployments } from "./resources";
import { Auth, Teams, type ApprovalEnvironment } from "./services";
import { approvalProjectionPatchManifest } from "./projection-manifest";
import type {
  ApprovalProjection,
  ApprovalUIState,
  AuditEntry,
  Deployment as DeploymentRecord,
  DeploymentDetail,
  DeploymentRun as DeploymentRunRecord,
  DeploymentRunSummary,
  DeploymentSummary,
} from "./types";

export const approvalScreen: ScreenDefinition<
  ApprovalEnvironment,
  ApprovalUIState,
  ApprovalProjection
> = {
  route: Route.define("/teams/:teamId/deployments", {
    params: Schema.Struct({ teamId: Schema.String }),
  }),
  patchManifest: approvalProjectionPatchManifest,
  project(view, context) {
    return Effect.gen(function* () {
      const teamId = view.params.teamId;
      const teams = yield* Teams;
      const auth = yield* Auth;
      const team = teams.find(teamId);
      const currentUser = auth.currentUser();
      const pendingDeployments = yield* context.region("pendingDeployments", () =>
        Effect.map(context.resources.read(PendingDeployments(teamId)), (deployments) =>
          deployments.map(summary),
        ),
      );
      const activeRuns = yield* context.region("activeRuns", () =>
        Effect.map(context.resources.read(ActiveDeploymentRuns(teamId)), (runs) =>
          runs.map(runSummary),
        ),
      );
      const selectedDeployment = view.ui.selectedDeploymentId
        ? yield* context.region("selectedDeployment", () =>
            selectedDetail(view.ui.selectedDeploymentId as string, context),
          )
        : null;

      const tracePanel = yield* context.region("tracePanel", () =>
        Effect.succeed({
          open: view.ui.tracePanelOpen,
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
        activeRuns,
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

function runSummary(run: DeploymentRunRecord): DeploymentRunSummary {
  return {
    id: run.id,
    label: run.label,
    status: run.status,
    progress: run.progress,
    updatedAt: run.updatedAt,
  };
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
