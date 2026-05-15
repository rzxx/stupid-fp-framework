import { Effect, Resource, Schema, type ResourceDefinition } from "../../framework";
import { Audit, DeploymentRuns, Deployments, type ApprovalEnvironment } from "./services";
import type { AuditEntry, Deployment, DeploymentRun } from "./types";

type TeamResourceParams = {
  teamId: string;
};

type DeploymentResourceParams = {
  deploymentId: string;
};

const teamParams = Schema.Struct({ teamId: Schema.String });
const deploymentParams = Schema.Struct({ deploymentId: Schema.String });

export const PendingDeploymentsResource = Resource.define("PendingDeployments")
  .value<Deployment[]>()
  .key<TeamResourceParams>(teamParams, {
    id: (params) => params.teamId,
  })
  .load<ApprovalEnvironment>((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pendingForTeam(params.teamId);
    }),
  );

export const DeploymentResource = Resource.define("Deployment")
  .value<Deployment | undefined>()
  .key<DeploymentResourceParams>(deploymentParams, {
    id: (params) => params.deploymentId,
  })
  .load<ApprovalEnvironment>((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.find(params.deploymentId);
    }),
  );

export const AuditTrailResource = Resource.define("AuditTrail")
  .value<AuditEntry[]>()
  .key<DeploymentResourceParams>(deploymentParams, {
    id: (params) => params.deploymentId,
  })
  .load<ApprovalEnvironment>((params) =>
    Effect.gen(function* () {
      const audit = yield* Audit;
      return audit.forDeployment(params.deploymentId);
    }),
  );

export const ActiveDeploymentRunsResource = Resource.define("ActiveDeploymentRuns")
  .value<DeploymentRun[]>()
  .key<TeamResourceParams>(teamParams, {
    id: (params) => params.teamId,
  })
  .load<ApprovalEnvironment>((params) =>
    Effect.gen(function* () {
      const runs = yield* DeploymentRuns;
      return runs.forTeam(params.teamId);
    }),
  );

export const approvalResources: ResourceDefinition<ApprovalEnvironment, unknown>[] = [
  PendingDeploymentsResource,
  DeploymentResource,
  AuditTrailResource,
  ActiveDeploymentRunsResource,
];
