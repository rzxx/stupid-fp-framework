import { describe, expect, test } from "vitest";
import { createApprovalRuntime } from "../src/demo/approvals/program";
import type { ApprovalProjection } from "../src/demo/approvals/types";
import {
  parseClientEnvelope,
  type ProjectionEnvelope,
  type ProjectionPatchEnvelope,
  type ServerEnvelope,
  type TraceSnapshot,
} from "../src/framework";

describe("prototype runtime", () => {
  test("connect creates a view and initial projection", async () => {
    const runtime = createApprovalRuntime();
    const result = await runtime.connect({
      type: "connect",
      route: "/teams/:teamId/deployments",
      params: { teamId: "team-platform" },
    });

    expect(result.envelopes[0]).toMatchObject({ type: "connected" });

    const projection = latestProjection(result.envelopes);
    expect(projection.projectionVersion).toBe(1);
    expect(projection.projection.pendingDeployments).toHaveLength(3);
    expect(projection.projection.selectedDeployment).toBeNull();
  });

  test("view selection changes projection without mutating durable workflow state", async () => {
    const runtime = createApprovalRuntime();
    const connected = await connect(runtime);
    const before = latestProjection(connected.envelopes).projection;
    const deploymentId = before.pendingDeployments[0]?.id;

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "ui.deployment.select", deploymentId },
    });
    const patch = latestPatch(result.envelopes);
    const trace = result.envelopes.find((envelope) => envelope.type === "trace:update");
    const selected = patch.patch.regions.find((region) => region.id === "selectedDeployment");

    expect(selected?.value).toMatchObject({ id: deploymentId });
    expect(trace?.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "ui",
          label: "ui.deployment.select applied",
        }),
      ]),
    );
    const pendingDeployments = patch.patch.regions.find(
      (region) => region.id === "pendingDeployments",
    );
    expect(Array.isArray(pendingDeployments?.value) ? pendingDeployments.value : []).toHaveLength(
      before.pendingDeployments.length,
    );
  });

  test("action returns result, patch, and trace envelopes", async () => {
    const runtime = createApprovalRuntime();
    const connected = await connect(runtime);
    const deploymentId = latestProjection(connected.envelopes).projection.pendingDeployments[0]?.id;

    const result = await runtime.receive({
      type: "input",
      viewId: connected.viewId,
      input: { type: "action.approveDeployment", deploymentId },
    });

    expect(result.envelopes.map((envelope) => envelope.type)).toEqual([
      "action:result",
      "projection:patch",
      "trace:update",
    ]);
    expect(latestPatch(result.envelopes).projectionVersion).toBe(2);

    const trace = result.envelopes.find((envelope) => envelope.type === "trace:update");
    expect(trace?.trace.events.map((event) => event.phase)).toContain("resource");
    expect(trace?.trace.events.map((event) => event.phase)).toContain("projection");
  });

  test("malformed stream envelopes fail at protocol boundary", () => {
    expect(parseClientEnvelope("not json")).toMatchObject({
      type: "error",
      message: "Malformed JSON envelope",
    });
    expect(parseClientEnvelope(JSON.stringify({ type: "input" }))).toMatchObject({
      type: "error",
      message: "Invalid input envelope",
    });
  });

  test("unknown view returns an error envelope", async () => {
    const runtime = createApprovalRuntime();
    const result = await runtime.receive({
      type: "input",
      viewId: "missing",
      input: { type: "ui.trace.toggle" },
    });

    expect(result.envelopes).toEqual([
      { type: "error", viewId: "missing", message: "Unknown view" },
    ]);
  });
});

async function connect(runtime: ReturnType<typeof createApprovalRuntime>) {
  const result = await runtime.connect({
    type: "connect",
    route: "/teams/:teamId/deployments",
    params: { teamId: "team-platform" },
  });
  const connected = result.envelopes.find((envelope) => envelope.type === "connected");

  if (!connected) {
    throw new Error("Expected connected envelope");
  }

  return { viewId: connected.viewId, envelopes: result.envelopes };
}

function latestProjection(
  envelopes: ServerEnvelope<ApprovalProjection, TraceSnapshot>[],
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
  envelopes: ServerEnvelope<ApprovalProjection, TraceSnapshot>[],
): ProjectionPatchEnvelope {
  const patch = envelopes.find(
    (envelope): envelope is ProjectionPatchEnvelope => envelope.type === "projection:patch",
  );

  if (!patch) {
    throw new Error("Expected projection patch envelope");
  }

  return patch;
}
