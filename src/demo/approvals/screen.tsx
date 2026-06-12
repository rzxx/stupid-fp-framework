import {
  Effect,
  Layout,
  Screen,
  Schema,
  type ProjectionContext,
  type ScreenDefinition,
} from "../../framework";
import { approvalProjectionPatchManifest } from "./projection";
import {
  ActiveDeploymentRunsResource,
  AuditTrailResource,
  DeploymentResource,
  PendingDeploymentsResource,
} from "./resources";
import { Auth, Teams, type ApprovalEnvironment } from "./services";
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

const operationsLayout = Layout.define("approvals.operations");
const teamRouteParams = Schema.Struct({ teamId: Schema.String });

export const approvalDeploymentsScreen: ScreenDefinition<
  ApprovalEnvironment,
  ApprovalUIState,
  ApprovalProjection
> = Screen.define("approval.deployments")
  .layout(operationsLayout)
  .route("/teams/:teamId/deployments", {
    params: teamRouteParams,
  })
  .patchManifest(approvalProjectionPatchManifest)
  .projectEffect((view, context) => {
    return Effect.gen(function* () {
      const teamId = view.params.teamId;
      const layout = yield* approvalLayout(view, context);
      const pendingDeployments = yield* context.region("pendingDeployments", () =>
        Effect.map(
          context.resources.read(PendingDeploymentsResource.key({ teamId })),
          (deployments) => deployments.map(summary),
        ),
      );
      const activeRuns = yield* activeRunsRegion(teamId, context);
      const selectedDeployment = view.ui.selectedDeploymentId
        ? yield* context.region("selectedDeployment", () =>
            selectedDetail(view.ui.selectedDeploymentId as string, context),
          )
        : null;

      const projection: ApprovalProjection = {
        ...layout,
        route: "/teams/:teamId/deployments",
        page: "deployments",
        pendingDeployments,
        selectedDeployment,
        activeRuns,
      };

      return projection;
    });
  });

export const approvalRunsScreen: ScreenDefinition<
  ApprovalEnvironment,
  ApprovalUIState,
  ApprovalProjection
> = Screen.define("approval.runs")
  .layout(operationsLayout)
  .route("/teams/:teamId/runs", {
    params: teamRouteParams,
  })
  .patchManifest(approvalProjectionPatchManifest)
  .projectEffect((view, context) => {
    return Effect.gen(function* () {
      const teamId = view.params.teamId;
      const layout = yield* approvalLayout(view, context);
      const activeRuns = yield* activeRunsRegion(teamId, context);

      const projection: ApprovalProjection = {
        ...layout,
        route: "/teams/:teamId/runs",
        page: "runs",
        pendingDeployments: [],
        selectedDeployment: null,
        activeRuns,
      };

      return projection;
    });
  });

export const approvalScreens = [approvalDeploymentsScreen, approvalRunsScreen];

function approvalLayout(
  view: { params: Record<string, string>; ui: ApprovalUIState },
  context: ProjectionContext<ApprovalEnvironment>,
) {
  return context.region("layout", () =>
    Effect.gen(function* () {
      const teamId = view.params.teamId;
      const teams = yield* Teams;
      const auth = yield* Auth;
      const team = teams.find(teamId);
      const currentUser = auth.currentUser();

      return {
        team,
        currentUser: {
          id: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
        },
        navigation: {
          deploymentsPath: `/teams/${teamId}/deployments`,
          runsPath: `/teams/${teamId}/runs`,
        },
        tracePanelOpen: view.ui.tracePanelOpen,
        traces: context.traces.list(),
      };
    }),
  );
}

function activeRunsRegion(teamId: string, context: ProjectionContext<ApprovalEnvironment>) {
  return context.region("activeRuns", () =>
    Effect.map(context.resources.read(ActiveDeploymentRunsResource.key({ teamId })), (runs) =>
      runs.map(runSummary),
    ),
  );
}

function selectedDetail(deploymentId: string, context: ProjectionContext<ApprovalEnvironment>) {
  return Effect.gen(function* () {
    const deployment = yield* context.resources.read(DeploymentResource.key({ deploymentId }));

    if (!deployment) {
      return null;
    }

    const auditTrail = yield* context.resources.read(AuditTrailResource.key({ deploymentId }));

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
