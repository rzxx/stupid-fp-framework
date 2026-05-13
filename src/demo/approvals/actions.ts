import { actionFailure, defineAction, Effect, type ActionDefinition } from "../../framework";
import { AuditTrail, Deployment, PendingDeployments } from "./resources";
import { Audit, Auth, Clock, Deployments, type ApprovalEnvironment } from "./services";
import type { ApprovalActionMessage } from "./types";

export const approveDeploymentAction: ActionDefinition<
  ApprovalEnvironment,
  ApprovalActionMessage,
  { deploymentId: string; status: "approved" }
> = defineAction(
  "action.approveDeployment",
  (message): message is ApprovalActionMessage =>
    isMessage(message) &&
    message.type === "action.approveDeployment" &&
    "deploymentId" in message &&
    typeof message.deploymentId === "string",
  (message, context) =>
    Effect.gen(function* () {
      context.traces.add(context.trace, "validation", "input validated", {
        deploymentId: message.deploymentId,
      });

      const auth = yield* Auth;
      const deployments = yield* Deployments;
      const audit = yield* Audit;
      const clock = yield* Clock;

      const user = yield* Effect.sync(() => auth.currentUser());
      context.traces.add(context.trace, "auth", "current user loaded", {
        userId: user.id,
        role: user.role,
      });

      const deployment = yield* Effect.sync(() => deployments.find(message.deploymentId));

      if (!deployment) {
        return yield* Effect.fail(
          actionFailure("Unknown deployment", {
            deploymentId: message.deploymentId,
          }),
        );
      }

      if (user.role !== "approver") {
        context.traces.add(context.trace, "permission", "permission rejected", {
          userId: user.id,
          deploymentId: deployment.id,
        });
        return yield* Effect.fail(
          actionFailure("User is not allowed to approve deployments", {
            userId: user.id,
            deploymentId: deployment.id,
          }),
        );
      }

      if (!user.teamIds.includes(deployment.teamId)) {
        return yield* Effect.fail(
          actionFailure("User is not on the deployment team", {
            userId: user.id,
            deploymentId: deployment.id,
            teamId: deployment.teamId,
          }),
        );
      }

      if (deployment.status !== "pending") {
        return yield* Effect.fail(
          actionFailure("Deployment is not pending", {
            deploymentId: deployment.id,
            status: deployment.status,
          }),
        );
      }

      context.traces.add(context.trace, "permission", "permission accepted", {
        userId: user.id,
        deploymentId: deployment.id,
      });

      const approvedAt = clock.now();
      yield* Effect.sync(() => deployments.approve(deployment.id, user.id, approvedAt));
      context.traces.add(context.trace, "write", "deployment approved", {
        deploymentId: deployment.id,
        approvedBy: user.id,
      });

      yield* Effect.sync(() =>
        audit.write({
          actorId: user.id,
          event: "deployment.approved",
          deploymentId: deployment.id,
          detail: { service: deployment.service, version: deployment.version },
        }),
      );
      context.traces.add(context.trace, "write", "audit entry written", {
        deploymentId: deployment.id,
      });

      context.invalidate(Deployment(deployment.id));
      context.invalidate(PendingDeployments(deployment.teamId));
      context.invalidate(AuditTrail(deployment.id));

      return { deploymentId: deployment.id, status: "approved" as const };
    }),
);

export const approvalActions = [approveDeploymentAction];

function isMessage(value: unknown): value is { type: string } {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
