import { Context, Layer } from "../../framework";
import type { ApprovalData } from "./data";
import { createSeedData } from "./data";
import type { AuditEntry, Deployment, Team, User } from "./types";

export type AuthService = {
  currentUser: () => User;
  setCurrentUser: (userId: string) => void;
};

export type TeamService = {
  find: (teamId: string) => Team;
};

export type DeploymentService = {
  find: (deploymentId: string) => Deployment | undefined;
  pendingForTeam: (teamId: string) => Deployment[];
  approve: (deploymentId: string, userId: string, approvedAt: string) => Deployment;
};

export type AuditService = {
  forDeployment: (deploymentId: string) => AuditEntry[];
  write: (entry: Omit<AuditEntry, "id" | "at">) => AuditEntry;
};

export type ClockService = {
  now: () => string;
};

export type ApprovalServices = {
  auth: AuthService;
  teams: TeamService;
  deployments: DeploymentService;
  audit: AuditService;
  clock: ClockService;
  data: ApprovalData;
};

export class Auth extends Context.Tag("approvals/Auth")<Auth, AuthService>() {}
export class Teams extends Context.Tag("approvals/Teams")<Teams, TeamService>() {}
export class Deployments extends Context.Tag("approvals/Deployments")<
  Deployments,
  DeploymentService
>() {}
export class Audit extends Context.Tag("approvals/Audit")<Audit, AuditService>() {}
export class Clock extends Context.Tag("approvals/Clock")<Clock, ClockService>() {}

export type ApprovalEnvironment = Auth | Teams | Deployments | Audit | Clock;

export function createApprovalServices(options?: {
  currentUserId?: string;
  data?: ApprovalData;
}): ApprovalServices {
  const data = options?.data ?? createSeedData();
  let currentUserId = options?.currentUserId ?? "user-approver";
  let auditSequence = data.audit.length + 1;

  return {
    data,
    auth: {
      currentUser() {
        const user = data.users.find((entry) => entry.id === currentUserId);

        if (!user) {
          throw new Error(`Unknown current user ${currentUserId}`);
        }

        return user;
      },
      setCurrentUser(userId) {
        currentUserId = userId;
      },
    },
    teams: {
      find(teamId) {
        const team = data.teams.find((entry) => entry.id === teamId);

        if (!team) {
          throw new Error(`Unknown team ${teamId}`);
        }

        return team;
      },
    },
    deployments: {
      find(deploymentId) {
        return data.deployments.find((deployment) => deployment.id === deploymentId);
      },
      pendingForTeam(teamId) {
        return data.deployments.filter(
          (deployment) => deployment.teamId === teamId && deployment.status === "pending",
        );
      },
      approve(deploymentId, userId, approvedAt) {
        const deployment = data.deployments.find((entry) => entry.id === deploymentId);

        if (!deployment) {
          throw new Error(`Unknown deployment ${deploymentId}`);
        }

        deployment.status = "approved";
        deployment.approvedBy = userId;
        deployment.approvedAt = approvedAt;

        return deployment;
      },
    },
    audit: {
      forDeployment(deploymentId) {
        return data.audit.filter((entry) => entry.deploymentId === deploymentId);
      },
      write(entry) {
        const audit: AuditEntry = {
          ...entry,
          id: `audit-${auditSequence++}`,
          at: new Date().toISOString(),
        };

        data.audit.push(audit);
        return audit;
      },
    },
    clock: {
      now() {
        return new Date().toISOString();
      },
    },
  };
}

export function createApprovalLayer(services: ApprovalServices): Layer.Layer<ApprovalEnvironment> {
  return Layer.mergeAll(
    Layer.succeed(Auth, services.auth),
    Layer.succeed(Teams, services.teams),
    Layer.succeed(Deployments, services.deployments),
    Layer.succeed(Audit, services.audit),
    Layer.succeed(Clock, services.clock),
  );
}
