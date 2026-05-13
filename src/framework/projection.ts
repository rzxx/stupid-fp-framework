import type { Effect } from "./effect";
import type { JsonRecord, JsonValue } from "./json";
import type { ResourceFailure, ResourceGraph } from "./resource";
import type { RouteDefinition } from "./route";
import type { Session } from "./session";
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

export type ScreenDefinition<R, TSessionState, TProjection> = {
  route: string | RouteDefinition;
  project: (
    session: Session<TSessionState>,
    context: ProjectionContext<R>,
  ) => Effect.Effect<TProjection, ProjectionFailure | ResourceFailure, R>;
};

export type ProjectionEnvelopeData<TProjection> = {
  projectionVersion: number;
  projection: TProjection;
  regions: ProjectionRegionSnapshot[];
};

export type ProjectionMeta = JsonRecord;
