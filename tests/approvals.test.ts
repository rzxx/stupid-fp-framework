import { describe, expect, test } from "bun:test";
import { createApprovalRuntime } from "../src/demo/approvals/program";
import { createApprovalServices } from "../src/demo/approvals/services";
import type { ApprovalProjection } from "../src/demo/approvals/types";
import type { ProjectionEnvelope } from "../src/framework";

describe("deployment approval workflow", () => {
  test("approver can approve a pending deployment through the server program", async () => {
    const services = createApprovalServices();
    const runtime = createApprovalRuntime({ services });
    const connected = await connect(runtime);
    const deploymentId = connected.projection.pendingDeployments[0]?.id;

    expect(deploymentId).toBeString();

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.approveDeployment", deploymentId },
    });
    const projection = latestProjection(result.envelopes);
    const actionResult = result.envelopes.find((envelope) => envelope.type === "action:result");

    expect(actionResult).toMatchObject({
      ok: true,
      result: { deploymentId, status: "approved" },
    });
    expect(
      projection.projection.pendingDeployments.some((deployment) => deployment.id === deploymentId),
    ).toBe(false);
    expect(services.deployments.find(deploymentId)?.status).toBe("approved");
    expect(
      services.audit
        .forDeployment(deploymentId)
        .some((entry) => entry.event === "deployment.approved"),
    ).toBe(true);
  });

  test("viewer cannot approve and durable deployment state is not mutated", async () => {
    const services = createApprovalServices({ currentUserId: "user-viewer" });
    const runtime = createApprovalRuntime({ services });
    const connected = await connect(runtime);
    const deploymentId = connected.projection.pendingDeployments[0]?.id;
    const auditCount = services.audit.forDeployment(deploymentId).length;

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.approveDeployment", deploymentId },
    });
    const actionResult = result.envelopes.find((envelope) => envelope.type === "action:result");

    expect(actionResult).toMatchObject({ ok: false });
    expect(services.deployments.find(deploymentId)?.status).toBe("pending");
    expect(services.audit.forDeployment(deploymentId)).toHaveLength(auditCount);
  });

  test("already approved deployments cannot be approved twice", async () => {
    const services = createApprovalServices();
    const runtime = createApprovalRuntime({ services });
    const connected = await connect(runtime);
    const auditCount = services.audit.forDeployment("deploy-search-23").length;

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: {
        type: "action.approveDeployment",
        deploymentId: "deploy-search-23",
      },
    });
    const actionResult = result.envelopes.find((envelope) => envelope.type === "action:result");

    expect(actionResult).toMatchObject({ ok: false });
    expect(services.audit.forDeployment("deploy-search-23")).toHaveLength(auditCount);
  });
});

async function connect(runtime: ReturnType<typeof createApprovalRuntime>) {
  const result = await runtime.connect({
    type: "connect",
    route: "/teams/:teamId/deployments",
    params: { teamId: "team-platform" },
  });
  const connected = result.envelopes.find((envelope) => envelope.type === "connected");
  const projection = latestProjection(result.envelopes);

  if (!connected) {
    throw new Error("Expected connected envelope");
  }

  return { sessionId: connected.sessionId, projection: projection.projection };
}

function latestProjection(
  envelopes: Awaited<ReturnType<ReturnType<typeof createApprovalRuntime>["connect"]>>["envelopes"],
): ProjectionEnvelope<ApprovalProjection> {
  const projection = envelopes.find(
    (envelope): envelope is ProjectionEnvelope<ApprovalProjection> =>
      envelope.type === "projection:update",
  );

  if (!projection) {
    throw new Error("Expected projection envelope");
  }

  return projection;
}
