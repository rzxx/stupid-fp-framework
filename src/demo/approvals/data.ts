import type { AuditEntry, Deployment, Team, User } from "./types";

export type ApprovalData = {
  teams: Team[];
  users: User[];
  deployments: Deployment[];
  audit: AuditEntry[];
};

export function createSeedData(): ApprovalData {
  return {
    teams: [{ id: "team-platform", name: "Platform" }],
    users: [
      {
        id: "user-approver",
        name: "Ada Approver",
        role: "approver",
        teamIds: ["team-platform"],
      },
      {
        id: "user-viewer",
        name: "Vic Viewer",
        role: "viewer",
        teamIds: ["team-platform"],
      },
    ],
    deployments: [
      {
        id: "deploy-api-142",
        teamId: "team-platform",
        service: "payments-api",
        version: "v4.18.0",
        environment: "production",
        status: "pending",
        requestedBy: "Nia",
        requestedAt: "2026-05-13T09:00:00.000Z",
      },
      {
        id: "deploy-web-91",
        teamId: "team-platform",
        service: "merchant-web",
        version: "v2.31.5",
        environment: "production",
        status: "pending",
        requestedBy: "Oleg",
        requestedAt: "2026-05-13T09:08:00.000Z",
      },
      {
        id: "deploy-worker-77",
        teamId: "team-platform",
        service: "settlement-worker",
        version: "v1.12.2",
        environment: "production",
        status: "pending",
        requestedBy: "Mira",
        requestedAt: "2026-05-13T09:16:00.000Z",
      },
      {
        id: "deploy-search-23",
        teamId: "team-platform",
        service: "search-indexer",
        version: "v0.44.1",
        environment: "production",
        status: "approved",
        requestedBy: "Pavel",
        requestedAt: "2026-05-13T08:40:00.000Z",
        approvedBy: "user-approver",
        approvedAt: "2026-05-13T08:45:00.000Z",
      },
    ],
    audit: [
      requestEntry("audit-api-142-request", "deploy-api-142", "Nia"),
      requestEntry("audit-web-91-request", "deploy-web-91", "Oleg"),
      requestEntry("audit-worker-77-request", "deploy-worker-77", "Mira"),
      requestEntry("audit-search-23-request", "deploy-search-23", "Pavel"),
      {
        id: "audit-search-23-approved",
        at: "2026-05-13T08:45:00.000Z",
        actorId: "user-approver",
        event: "deployment.approved",
        deploymentId: "deploy-search-23",
        detail: { service: "search-indexer" },
      },
    ],
  };
}

function requestEntry(id: string, deploymentId: string, actorId: string): AuditEntry {
  return {
    id,
    at: "2026-05-13T08:30:00.000Z",
    actorId,
    event: "deployment.approval_requested",
    deploymentId,
    detail: { deploymentId },
  };
}
