import type { JsonValue } from "../json";
import type { ProjectionRegionSnapshot } from "../projection";
import type { ProjectionPatchEnvelope } from "../stream";

export function patchableRegions(
  regions: ProjectionRegionSnapshot[],
): ProjectionPatchEnvelope["patch"]["regions"] | null {
  const patchRegions: ProjectionPatchEnvelope["patch"]["regions"] = [];

  for (const region of regions) {
    if (region.value === undefined) {
      return null;
    }

    patchRegions.push({
      id: region.id,
      value: region.value as JsonValue,
      resources: region.resources,
    });
  }

  return patchRegions;
}
