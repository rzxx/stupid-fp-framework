import type {
  JsonValue,
  ProjectionPatchEnvelope,
  ProjectionPatchManifest,
  ProjectionPath,
  ProjectionRegionPatchStrategy,
} from "../../framework";

export type RegionValuePatchHandlers<TProjection> = Record<
  string,
  (projection: TProjection, value: JsonValue) => TProjection
>;

export type RegionValuePatchStrategy<TProjection> = ProjectionRegionPatchStrategy<TProjection>;

export type {
  ProjectionPatchManifest,
  ProjectionPath,
  ProjectionRegionPatchStrategy,
} from "../../framework";

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

    if (!apply) {
      throw new Error(`No projection patch handler registered for region: ${region.id}`);
    }

    next = apply(next, region.value);
  }

  return next;
}

export function createProjectionPatchApplier<TProjection>(
  manifest?: ProjectionPatchManifest<TProjection>,
): (projection: TProjection, envelope: ProjectionPatchEnvelope) => TProjection {
  return (projection, envelope) =>
    manifest
      ? applyRegionValuePatchWithManifest(projection, envelope, manifest)
      : applyRegionValuePatchAutomatically(projection, envelope);
}

export function applyRegionValuePatchWithManifest<TProjection>(
  projection: TProjection,
  envelope: ProjectionPatchEnvelope,
  manifest: ProjectionPatchManifest<TProjection>,
): TProjection {
  if (envelope.patch.kind !== "region-values") {
    return projection;
  }

  if (
    envelope.projectionManifestVersion !== undefined &&
    envelope.projectionManifestVersion !== manifest.projectionVersion
  ) {
    throw new Error(
      `Projection patch manifest version mismatch: received ${envelope.projectionManifestVersion}, expected ${manifest.projectionVersion}`,
    );
  }

  let next = projection;

  for (const region of envelope.patch.regions) {
    const strategy = manifest.regions[region.id];

    if (!strategy) {
      throw new Error(`No projection patch strategy registered for region: ${region.id}`);
    }

    next = applyStrategy(next, region.id, region.value, strategy);
  }

  return next;
}

export function applyRegionValuePatchAutomatically<TProjection>(
  projection: TProjection,
  envelope: ProjectionPatchEnvelope,
): TProjection {
  if (envelope.patch.kind !== "region-values") {
    return projection;
  }

  return envelope.patch.regions.reduce(
    (current, region) => applyAutomaticRegionPatch(current, region.id, region.value),
    projection,
  );
}

function applyStrategy<TProjection>(
  projection: TProjection,
  regionId: string,
  value: JsonValue,
  strategy: RegionValuePatchStrategy<TProjection>,
): TProjection {
  if (strategy.kind === "custom") {
    return strategy.apply(projection, value);
  }

  if (strategy.kind === "replace-region") {
    return setPath(projection, [regionId], value);
  }

  if (strategy.kind === "merge-fields") {
    return mergeFields(projection, value);
  }

  if (strategy.kind === "replace-at-path") {
    return setPath(projection, strategy.path, value);
  }

  return strategy.fields.reduce((current, field) => {
    const source = getPath(value, field.from);
    return setPath(current, field.to, source);
  }, projection);
}

function applyAutomaticRegionPatch<TProjection>(
  projection: TProjection,
  regionId: string,
  value: JsonValue,
): TProjection {
  if (
    projection !== null &&
    typeof projection === "object" &&
    !Array.isArray(projection) &&
    regionId in projection
  ) {
    return setPath(projection, [regionId], value);
  }

  return mergeFields(projection, value);
}

function mergeFields<TProjection>(projection: TProjection, value: JsonValue): TProjection {
  if (
    projection !== null &&
    typeof projection === "object" &&
    !Array.isArray(projection) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return {
      ...(projection as Record<string, unknown>),
      ...(value as Record<string, unknown>),
    } as TProjection;
  }

  return projection;
}

function setPath<TProjection>(
  projection: TProjection,
  path: ProjectionPath,
  value: unknown,
): TProjection {
  if (path.length === 0) {
    return value as TProjection;
  }

  return setPathInner(projection, path, value) as TProjection;
}

function setPathInner(current: unknown, path: ProjectionPath, value: unknown): unknown {
  const [head, ...tail] = path;

  if (head === undefined) {
    return value;
  }

  if (typeof head === "number") {
    const array = Array.isArray(current) ? [...current] : [];
    array[head] = setPathInner(array[head], tail, value);
    return array;
  }

  const object =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  object[head] = setPathInner(object[head], tail, value);
  return object;
}

function getPath(value: unknown, path: ProjectionPath): unknown {
  return path.reduce((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof segment === "number") {
      return Array.isArray(current) ? current[segment] : undefined;
    }

    return typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined;
  }, value);
}
