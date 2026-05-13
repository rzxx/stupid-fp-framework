import { Effect } from "effect";
import { actionFailure, defineAction, type ActionDefinition } from "../../framework";
import { AuditTrail, Deployment, PendingDeployments } from "./resources";
import type { ApprovalServices } from "./services";
import type { ApprovalActionMessage } from "./types";

export const approveDeploymentAction: ActionDefinition<ApprovalServices, ApprovalActionMessage> =
  defineAction("action.approveDeployment", (message, context) =>
    Effect.gen(function* () {
      context.traces.add(context.trace, "validation", "input validated", {
        deploymentId: message.deploymentId,
      });

      const user = yield* Effect.sync(() => context.services.auth.currentUser());
      context.traces.add(context.trace, "auth", "current user loaded", {
        userId: user.id,
        role: user.role,
      });

      const deployment = yield* Effect.sync(() =>
        context.services.deployments.find(message.deploymentId),
      );

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

      const approvedAt = context.services.clock.now();
      yield* Effect.sync(() =>
        context.services.deployments.approve(deployment.id, user.id, approvedAt),
      );
      context.traces.add(context.trace, "write", "deployment approved", {
        deploymentId: deployment.id,
        approvedBy: user.id,
      });

      yield* Effect.sync(() =>
        context.services.audit.write({
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
    }),
  );

export const approvalActions = [approveDeploymentAction];
