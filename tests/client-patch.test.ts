import { describe, expect, test } from "vitest";
import {
  applyRegionValuePatch,
  applyRegionValuePatchAutomatically,
  createProjectionPatchApplier,
  type ProjectionPatchManifest,
} from "../src/adapters/react/projection-patch";
import type { ProjectionPatchEnvelope } from "../src/framework";

describe("client projection patches", () => {
  test("applies region value patches without replacing unrelated projection state", () => {
    const projection = {
      count: 1,
      selected: "deployment-a",
      localLabel: "kept",
    };
    const patch: ProjectionPatchEnvelope = {
      type: "projection:patch",
      viewId: "view-1",
      cursor: "cursor-2",
      projectionVersion: 2,
      patch: {
        kind: "region-values",
        regions: [
          {
            id: "counter",
            value: 2,
            resources: [{ type: "Counter", id: "main", label: "Counter(main)" }],
          },
        ],
      },
    };

    const next = applyRegionValuePatch(projection, patch, {
      counter: (current, value) =>
        typeof value === "number" ? { ...current, count: value } : current,
    });

    expect(next).toEqual({
      count: 2,
      selected: "deployment-a",
      localLabel: "kept",
    });
  });

  test("rejects patches without a registered region handler", () => {
    const patch: ProjectionPatchEnvelope = {
      type: "projection:patch",
      viewId: "view-1",
      cursor: "cursor-2",
      projectionVersion: 2,
      patch: {
        kind: "region-values",
        regions: [{ id: "missing", value: 2, resources: [] }],
      },
    };

    expect(() => applyRegionValuePatch({ count: 1 }, patch, {})).toThrow(
      "No projection patch handler registered for region: missing",
    );
  });

  test("applies region value patches from a projection manifest", () => {
    type Projection = {
      count: number;
      tracePanelOpen: boolean;
      traces: { traceId: string }[];
    };
    const manifest: ProjectionPatchManifest<Projection> = {
      projectionVersion: 1,
      regions: {
        counter: {
          kind: "replace-at-path",
          path: ["count"],
        },
        tracePanel: {
          kind: "replace-fields",
          fields: [
            { from: ["open"], to: ["tracePanelOpen"] },
            { from: ["traces"], to: ["traces"] },
          ],
        },
      },
    };
    const applyPatch = createProjectionPatchApplier(manifest);
    const patch: ProjectionPatchEnvelope = {
      type: "projection:patch",
      viewId: "view-1",
      cursor: "cursor-2",
      projectionVersion: 2,
      patch: {
        kind: "region-values",
        regions: [
          { id: "counter", value: 2, resources: [] },
          {
            id: "tracePanel",
            value: { open: true, traces: [{ traceId: "trace-1" }] },
            resources: [],
          },
        ],
      },
    };

    expect(applyPatch({ count: 1, tracePanelOpen: false, traces: [] }, patch)).toEqual({
      count: 2,
      tracePanelOpen: true,
      traces: [{ traceId: "trace-1" }],
    });
  });

  test("automatically replaces matching region fields and merges layout regions", () => {
    const patch: ProjectionPatchEnvelope = {
      type: "projection:patch",
      viewId: "view-1",
      cursor: "cursor-2",
      projectionVersion: 2,
      patch: {
        kind: "region-values",
        regions: [
          {
            id: "layout",
            value: { title: "Updated", tracePanelOpen: true },
            resources: [],
          },
          {
            id: "items",
            value: ["a", "b"],
            resources: [],
          },
        ],
      },
    };

    expect(
      applyRegionValuePatchAutomatically(
        { title: "Initial", tracePanelOpen: false, items: ["a"], local: "kept" },
        patch,
      ),
    ).toEqual({
      title: "Updated",
      tracePanelOpen: true,
      items: ["a", "b"],
      local: "kept",
    });
  });

  test("supports region-first manifest strategies", () => {
    type Projection = { title: string; items: string[] };
    const applyPatch = createProjectionPatchApplier<Projection>({
      projectionVersion: 1,
      regions: {
        layout: { kind: "merge-fields" },
        items: { kind: "replace-region" },
      },
    });
    const patch: ProjectionPatchEnvelope = {
      type: "projection:patch",
      viewId: "view-1",
      cursor: "cursor-2",
      projectionVersion: 2,
      projectionManifestVersion: 1,
      patch: {
        kind: "region-values",
        regions: [
          { id: "layout", value: { title: "Updated" }, resources: [] },
          { id: "items", value: ["a", "b"], resources: [] },
        ],
      },
    };

    expect(applyPatch({ title: "Initial", items: ["a"] }, patch)).toEqual({
      title: "Updated",
      items: ["a", "b"],
    });
  });

  test("rejects projection patches from incompatible manifest versions", () => {
    type Projection = { count: number };
    const applyPatch = createProjectionPatchApplier<Projection>({
      projectionVersion: 2,
      regions: {
        counter: {
          kind: "replace-at-path",
          path: ["count"],
        },
      },
    });
    const patch: ProjectionPatchEnvelope = {
      type: "projection:patch",
      viewId: "view-1",
      cursor: "cursor-2",
      projectionVersion: 2,
      projectionManifestVersion: 1,
      patch: {
        kind: "region-values",
        regions: [{ id: "counter", value: 2, resources: [] }],
      },
    };

    expect(() => applyPatch({ count: 1 }, patch)).toThrow(
      "Projection patch manifest version mismatch: received 1, expected 2",
    );
  });
});
