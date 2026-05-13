import { describe, expect, test } from "bun:test";
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
  test("connect creates a session and initial projection", async () => {
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

  test("session selection changes projection without mutating durable workflow state", async () => {
    const runtime = createApprovalRuntime();
    const connected = await connect(runtime);
    const before = latestProjection(connected.envelopes).projection;
    const deploymentId = before.pendingDeployments[0]?.id;

    const result = await runtime.receive({
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "session.selectDeployment", deploymentId },
    });
    const patch = latestPatch(result.envelopes);
    const selected = patch.patch.regions.find((region) => region.id === "selectedDeployment");

    expect(selected?.value).toMatchObject({ id: deploymentId });
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
      type: "message",
      sessionId: connected.sessionId,
      message: { type: "action.approveDeployment", deploymentId },
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
    expect(parseClientEnvelope(JSON.stringify({ type: "message" }))).toMatchObject({
      type: "error",
      message: "Invalid message envelope",
    });
  });

  test("unknown session returns an error envelope", async () => {
    const runtime = createApprovalRuntime();
    const result = await runtime.receive({
      type: "message",
      sessionId: "missing",
      message: { type: "session.toggleTracePanel" },
    });

    expect(result.envelopes).toEqual([
      { type: "error", sessionId: "missing", message: "Unknown session" },
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

  return { sessionId: connected.sessionId, envelopes: result.envelopes };
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
