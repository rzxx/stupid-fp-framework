import { Action, actionFailure, Effect, Schema, type ActionDefinition } from "../../framework";
import { AuditTrailResource, DeploymentResource, PendingDeploymentsResource } from "./resources";
import { Audit, Auth, Clock, Deployments, type ApprovalEnvironment } from "./services";
import type { ApprovalActionInput } from "./types";

export const approveDeploymentAction: ActionDefinition<
  ApprovalEnvironment,
  ApprovalActionInput,
  { deploymentId: string; status: "approved" }
> = Action.define("action.approveDeployment")
  .input(
    Schema.Struct({
      type: Schema.Literal("action.approveDeployment"),
      deploymentId: Schema.String,
    }),
  )
  .runEffect((input, context) =>
    Effect.gen(function* () {
      context.traces.add(context.trace, "validation", "input validated", {
        deploymentId: input.deploymentId,
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

      const deployment = yield* Effect.sync(() => deployments.find(input.deploymentId));

      if (!deployment) {
        return yield* Effect.fail(
          actionFailure("Unknown deployment", {
            deploymentId: input.deploymentId,
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

      context.invalidate(DeploymentResource.key({ deploymentId: deployment.id }));
      context.invalidate(PendingDeploymentsResource.key({ teamId: deployment.teamId }));
      context.invalidate(AuditTrailResource.key({ deploymentId: deployment.id }));

      return { deploymentId: deployment.id, status: "approved" as const };
    }),
  );

export const approvalActions = [approveDeploymentAction];
