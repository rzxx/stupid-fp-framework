import {
  defineResource,
  resourceKey,
  type ResourceDefinition,
  type ResourceKey,
} from "../../framework";
import type { ApprovalServices } from "./services";
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

export const approvalResources: ResourceDefinition<ApprovalServices, unknown>[] = [
  defineResource("PendingDeployments", (services, key) =>
    services.deployments.pendingForTeam(key.id),
  ),
  defineResource("Deployment", (services, key) => services.deployments.find(key.id)),
  defineResource("AuditTrail", (services, key) => services.audit.forDeployment(key.id)),
];
