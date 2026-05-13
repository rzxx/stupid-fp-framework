import type { JsonRecord } from "./json";
import type { ResourceGraph } from "./resource";
import type { Session } from "./session";
import type { TraceReader } from "./trace";

export type ProjectionContext<TServices> = {
  services: TServices;
  resources: ResourceGraph<TServices>;
  traces: TraceReader;
};

export type ScreenDefinition<TServices, TSessionState, TProjection> = {
  route: string;
  project: (
    session: Session<TSessionState>,
    context: ProjectionContext<TServices>,
  ) => Promise<TProjection> | TProjection;
};

export type ProjectionEnvelopeData<TProjection> = {
  projectionVersion: number;
  projection: TProjection;
};

export type ProjectionMeta = JsonRecord;
