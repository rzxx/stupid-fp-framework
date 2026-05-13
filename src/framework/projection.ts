import type { JsonRecord } from "./json";
import type { ResourceGraph } from "./resource";
import type { Session } from "./session";
import type { TraceReader } from "./trace";

export type ProjectionRegionSnapshot = {
  id: string;
  resources: {
    type: string;
    id: string;
    label: string;
  }[];
};

export type ProjectionContext<TServices> = {
  services: TServices;
  resources: ResourceGraph<TServices>;
  traces: TraceReader;
  region: <TValue>(id: string, read: () => Promise<TValue> | TValue) => Promise<TValue>;
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
  regions: ProjectionRegionSnapshot[];
};

export type ProjectionMeta = JsonRecord;
