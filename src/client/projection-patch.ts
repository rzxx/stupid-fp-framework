import type { JsonValue, ProjectionPatchEnvelope } from "../framework";

export type RegionValuePatchHandlers<TProjection> = Record<
  string,
  (projection: TProjection, value: JsonValue) => TProjection
>;

export function applyRegionValuePatch<TProjection>(
  projection: TProjection,
  envelope: ProjectionPatchEnvelope,
  handlers: RegionValuePatchHandlers<TProjection>,
): TProjection {
  if (envelope.patch.kind !== "region-values") {
    return projection;
  }

  let next = projection;

  for (const region of envelope.patch.regions) {
    const apply = handlers[region.id];

    if (!apply || region.value === undefined) {
      continue;
    }

    next = apply(next, region.value);
  }

  return next;
}
