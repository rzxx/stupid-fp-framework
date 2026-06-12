import { describe, expect, test } from "vitest";
import { createApprovalRuntime } from "../src/demo/approvals/program";
import { ActiveDeploymentRunsResource } from "../src/demo/approvals/resources";
import { createApprovalServices } from "../src/demo/approvals/services";
import type { ApprovalProjection } from "../src/demo/approvals/types";
import type { ProjectionEnvelope, ProjectionPatchEnvelope } from "../src/framework";

describe("deployment approval workflow", () => {
  test("approver can approve a pending deployment through the server program", async () => {
    const services = createApprovalServices();
    const runtime = createApprovalRuntime({ services });
    const connected = await connect(runtime);
    const deploymentId = connected.projection.pendingDeployments[0]?.id;

    expect(typeof deploymentId).toBe("string");

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.approveDeployment", deploymentId },
    });
    const patch = latestPatch(result.envelopes);
    const actionResult = result.envelopes.find((envelope) => envelope.type === "action:result");
    const pendingDeploymentsValue = patch.patch.regions.find(
      (region) => region.id === "pendingDeployments",
    )?.value;
    const pendingDeployments = Array.isArray(pendingDeploymentsValue)
      ? pendingDeploymentsValue
      : [];

    expect(patch.projectionManifestVersion).toBe(1);
    expect(actionResult).toMatchObject({
      ok: true,
      result: { deploymentId, status: "approved" },
    });
    expect(
      pendingDeployments.some(
        (deployment) =>
          deployment !== null &&
          typeof deployment === "object" &&
          "id" in deployment &&
          deployment.id === deploymentId,
      ),
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
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.approveDeployment", deploymentId },
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
      type: "input",
      viewId: connected.viewId,
      input: {
        type: "action.approveDeployment",
        deploymentId: "deploy-search-23",
      },
    });
    const actionResult = result.envelopes.find((envelope) => envelope.type === "action:result");

    expect(actionResult).toMatchObject({ ok: false });
    expect(services.audit.forDeployment("deploy-search-23")).toHaveLength(auditCount);
  });

  test("live deployment run resource updates through external invalidation", async () => {
    const services = createApprovalServices();
    const runtime = createApprovalRuntime({ services });
    const connected = await connect(runtime);

    services.runs.advance("run-api-rollout", 88);
    const result = await runtime.invalidate([
      ActiveDeploymentRunsResource.key({ teamId: "team-platform" }),
    ]);
    const patch = latestPatch(result.envelopes);
    const runsValue = patch.patch.regions.find((region) => region.id === "activeRuns")?.value;
    const runs = Array.isArray(runsValue) ? runsValue : [];

    expect(connected.projection.activeRuns).toHaveLength(2);
    expect(
      runs.some(
        (run) =>
          run !== null &&
          typeof run === "object" &&
          "id" in run &&
          run.id === "run-api-rollout" &&
          "progress" in run &&
          run.progress === 88,
      ),
    ).toBe(true);
  });

  test("route navigation swaps screens and preserves layout UI state", async () => {
    const runtime = createApprovalRuntime();
    const connected = await connect(runtime);

    const toggled = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "ui.trace.toggle" },
    });
    const toggledPatch = latestPatch(toggled.envelopes);
    const tracePanel = toggledPatch.patch.regions.find((region) => region.id === "layout")?.value;

    expect(tracePanel).toMatchObject({ tracePanelOpen: false });

    const navigated = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: {
        type: "system.navigate",
        path: "/teams/team-platform/runs",
        navigation: "push",
      },
    });
    const projection = latestProjection(navigated.envelopes).projection;
    const trace = navigated.envelopes.find((envelope) => envelope.type === "trace:update")?.trace;

    expect(projection.route).toBe("/teams/:teamId/runs");
    expect(projection.page).toBe("runs");
    expect(projection.activeRuns).toHaveLength(2);
    expect(projection.tracePanelOpen).toBe(false);
    expect(trace?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "system",
          label: "navigation resolved",
        }),
      ]),
    );
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

  return { viewId: connected.viewId, projection: projection.projection };
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

function latestPatch(
  envelopes: Awaited<ReturnType<ReturnType<typeof createApprovalRuntime>["connect"]>>["envelopes"],
): ProjectionPatchEnvelope {
  const patch = envelopes.find(
    (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
  );

  if (!patch) {
    throw new Error("Expected projection patch envelope");
  }

  return patch;
}
