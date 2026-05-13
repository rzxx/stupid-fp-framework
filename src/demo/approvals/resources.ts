import {
  defineResource,
  Effect,
  resourceKey,
  type ResourceDefinition,
  type ResourceKey,
} from "../../framework";
import { Audit, Deployments, type ApprovalEnvironment } from "./services";
import type { AuditEntry, Deployment } from "./types";

export function PendingDeployments(teamId: string): ResourceKey<Deployment[]> {
  return resourceKey("PendingDeployments", teamId, `PendingDeployments(${teamId})`);
}

export function Deployment(deploymentId: string): ResourceKey<Deployment | undefined> {
  return resourceKey("Deployment", deploymentId, `Deployment(${deploymentId})`);
}

export function AuditTrail(deploymentId: string): ResourceKey<AuditEntry[]> {
  return resourceKey("AuditTrail", deploymentId, `AuditTrail(${deploymentId})`);
}

export const approvalResources: ResourceDefinition<ApprovalEnvironment, unknown>[] = [
  defineResource("PendingDeployments", (key) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pendingForTeam(key.id);
    }),
  ),
  defineResource("Deployment", (key) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.find(key.id);
    }),
  ),
  defineResource("AuditTrail", (key) =>
    Effect.gen(function* () {
      const audit = yield* Audit;
      return audit.forDeployment(key.id);
    }),
  ),
];
