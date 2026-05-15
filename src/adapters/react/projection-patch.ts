import type { JsonValue, ProjectionPatchEnvelope } from "../../framework";

export type ProjectionPath = readonly (string | number)[];

export type RegionValuePatchHandlers<TProjection> = Record<
  string,
  (projection: TProjection, value: JsonValue) => TProjection
>;

export type RegionValuePatchStrategy<TProjection> =
  | {
      kind: "replace-at-path";
      path: ProjectionPath;
    }
  | {
      kind: "replace-fields";
      fields: {
        from: ProjectionPath;
        to: ProjectionPath;
      }[];
    }
  | {
      kind: "custom";
      apply: (projection: TProjection, value: JsonValue) => TProjection;
    };

export type ProjectionPatchManifest<TProjection> = {
  projectionVersion: number;
  regions: Record<string, RegionValuePatchStrategy<TProjection>>;
};

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
  manifest: ProjectionPatchManifest<TProjection>,
): (projection: TProjection, envelope: ProjectionPatchEnvelope) => TProjection {
  return (projection, envelope) =>
    applyRegionValuePatchWithManifest(projection, envelope, manifest);
}

export function applyRegionValuePatchWithManifest<TProjection>(
  projection: TProjection,
  envelope: ProjectionPatchEnvelope,
  manifest: ProjectionPatchManifest<TProjection>,
): TProjection {
  if (envelope.patch.kind !== "region-values") {
    return projection;
  }

  let next = projection;

  for (const region of envelope.patch.regions) {
    const strategy = manifest.regions[region.id];

    if (!strategy) {
      throw new Error(`No projection patch strategy registered for region: ${region.id}`);
    }

    next = applyStrategy(next, region.value, strategy);
  }

  return next;
}

function applyStrategy<TProjection>(
  projection: TProjection,
  value: JsonValue,
  strategy: RegionValuePatchStrategy<TProjection>,
): TProjection {
  if (strategy.kind === "custom") {
    return strategy.apply(projection, value);
  }

  if (strategy.kind === "replace-at-path") {
    return setPath(projection, strategy.path, value);
  }

  return strategy.fields.reduce((current, field) => {
    const source = getPath(value, field.from);
    return setPath(current, field.to, source);
  }, projection);
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
