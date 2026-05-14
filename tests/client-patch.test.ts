import { describe, expect, test } from "bun:test";
import { applyRegionValuePatch } from "../src/adapters/react/projection-patch";
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
});
