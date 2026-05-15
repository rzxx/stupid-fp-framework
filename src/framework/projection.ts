import type { Effect } from "./effect";
import type { JsonRecord, JsonValue } from "./json";
import type { ResourceFailure, ResourceGraph } from "./resource";
import type { RouteDefinition } from "./route";
import type { ViewContext } from "./view";
import type { TraceReader } from "./trace";

export type ProjectionRegionSnapshot = {
  id: string;
  value?: JsonValue;
  resources: {
    type: string;
    id: string;
    label: string;
  }[];
};

export type ProjectionPath = readonly (string | number)[];

export type ProjectionRegionPatchStrategy<TProjection> =
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
  regions: Record<string, ProjectionRegionPatchStrategy<TProjection>>;
};

export type ProjectionFailure = {
  type: "projection-error";
  message: string;
};

export type ProjectionContext<R> = {
  resources: ResourceGraph<R>;
  traces: TraceReader;
  region: <TValue, E>(
    id: string,
    read: () => Effect.Effect<TValue, E, R>,
  ) => Effect.Effect<TValue, E, R>;
};

export type ScreenDefinition<R, TUIState, TProjection> = {
  route: string | RouteDefinition;
  patchManifest?: ProjectionPatchManifest<TProjection>;
  project: (
    view: ViewContext<TUIState>,
    context: ProjectionContext<R>,
  ) => Effect.Effect<TProjection, ProjectionFailure | ResourceFailure, R>;
};

export type ProjectionEnvelopeData<TProjection> = {
  projectionVersion: number;
  projection: TProjection;
  regions: ProjectionRegionSnapshot[];
};

export type ProjectionMeta = JsonRecord;
