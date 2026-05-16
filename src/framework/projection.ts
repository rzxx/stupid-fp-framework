import type { Effect } from "./effect";
import type { JsonRecord, JsonValue } from "./json";
import type { ResourceFailure, ResourceGraph } from "./resource";
import { defineRoute, type RouteDefinition } from "./route";
import type { ViewContext } from "./view";
import type { TraceReader } from "./trace";

export type ProjectionRegionSnapshot = {
  id: string;
  value?: JsonValue;
  resources: {
    type: string;
    id: string;
    label: string;
    scope?: {
      kind: string;
      id: string;
      label: string;
    };
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

export type LayoutDefinition = {
  id: string;
};

export type ScreenDefinition<R, TUIState, TProjection> = {
  route: string | RouteDefinition;
  layout?: LayoutDefinition;
  patchManifest?: ProjectionPatchManifest<TProjection>;
  project: (
    view: ViewContext<TUIState>,
    context: ProjectionContext<R>,
  ) => Effect.Effect<TProjection, ProjectionFailure | ResourceFailure, R>;
};

export const Layout = {
  define(id: string): LayoutDefinition {
    return { id };
  },
};

export const Screen = {
  define(id: string) {
    return new ScreenBuilder(id);
  },
};

class ScreenBuilder<R = never, TUIState = never, TProjection = never> {
  readonly #id: string;
  #route: string | RouteDefinition | null = null;
  #layout: LayoutDefinition | undefined;
  #patchManifest: ProjectionPatchManifest<TProjection> | undefined;

  constructor(id: string) {
    this.#id = id;
  }

  route<TParams extends Record<string, string>>(
    pattern: string,
    options: { params: RouteDefinition<TParams>["params"] },
  ): ScreenBuilder<R, TUIState, TProjection> {
    this.#route = defineRoute(pattern, { id: this.#id, params: options.params });
    return this;
  }

  routeDefinition(route: string | RouteDefinition): ScreenBuilder<R, TUIState, TProjection> {
    this.#route = route;
    return this;
  }

  layout(layout: LayoutDefinition): ScreenBuilder<R, TUIState, TProjection> {
    this.#layout = layout;
    return this;
  }

  patchManifest<TNextProjection>(
    manifest: ProjectionPatchManifest<TNextProjection>,
  ): ScreenBuilder<R, TUIState, TNextProjection> {
    this.#patchManifest = manifest as unknown as ProjectionPatchManifest<TProjection>;
    return this as unknown as ScreenBuilder<R, TUIState, TNextProjection>;
  }

  project<TR, TNextUIState, TNextProjection>(
    project: (
      view: ViewContext<TNextUIState>,
      context: ProjectionContext<TR>,
    ) => Effect.Effect<TNextProjection, ProjectionFailure | ResourceFailure, TR>,
  ): ScreenDefinition<TR, TNextUIState, TNextProjection> {
    if (!this.#route) {
      throw new Error(`Screen ${this.#id} must define a route before project()`);
    }

    return {
      route: this.#route,
      layout: this.#layout,
      patchManifest: this.#patchManifest as unknown as ProjectionPatchManifest<TNextProjection>,
      project,
    };
  }
}

export type ProjectionEnvelopeData<TProjection> = {
  projectionVersion: number;
  projection: TProjection;
  regions: ProjectionRegionSnapshot[];
};

export type ProjectionMeta = JsonRecord;
