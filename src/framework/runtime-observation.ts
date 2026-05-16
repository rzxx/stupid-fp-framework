import type { ProjectionRegionSnapshot } from "./projection";
import { resourceKeyId, type ResourceKey } from "./resource";

export type AffectedRegion = {
  viewId: string;
  regions: ProjectionRegionSnapshot[];
};

export function sameParams(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

export function affectedRegions(
  views: { viewId: string; observedRegions: ProjectionRegionSnapshot[] }[],
  keys: readonly ResourceKey[],
): AffectedRegion[] {
  const invalidated = new Set(keys.map(resourceKeyId));
  const affected: AffectedRegion[] = [];

  for (const view of views) {
    const regions = view.observedRegions.filter((region) =>
      region.resources.some((resource) => invalidated.has(`${resource.type}:${resource.id}`)),
    );

    if (regions.length > 0) {
      affected.push({ viewId: view.viewId, regions });
    }
  }

  return affected;
}
