import type { ProjectionRegionSnapshot } from "./projection";
import type { UIStateDefinition } from "./ui-state";
import type { InvocationPrincipal } from "./invocation";

export const VIEW_CHECKPOINT_VERSION = 1;

export type ViewContext<TUIState> = {
  viewId: string;
  route: string;
  params: Record<string, string>;
  fanoutScope: string;
  principal?: InvocationPrincipal;
  ui: TUIState;
  projectionVersion: number;
  checkpointRevision: number;
  cursor: string | null;
  observedRegions: ProjectionRegionSnapshot[];
};

export class LiveViewRegistry<TUIState, TUIEvent> {
  readonly #definition: UIStateDefinition<TUIState, TUIEvent>;
  readonly #views = new Map<string, ViewContext<TUIState>>();
  #nextId = 1;

  constructor(definition: UIStateDefinition<TUIState, TUIEvent>) {
    this.#definition = definition;
  }

  create(
    route: string,
    params: Record<string, string>,
    options?: { fanoutScope?: string; principal?: InvocationPrincipal },
  ): ViewContext<TUIState> {
    const viewId = `view-${this.#nextId++}`;
    const view: ViewContext<TUIState> = {
      viewId,
      route,
      params,
      fanoutScope: options?.fanoutScope ?? "global",
      principal: options?.principal,
      ui: this.#definition.init(),
      projectionVersion: 0,
      checkpointRevision: 0,
      cursor: null,
      observedRegions: [],
    };

    this.#views.set(view.viewId, view);
    return view;
  }

  get(viewId: string): ViewContext<TUIState> | undefined {
    return this.#views.get(viewId);
  }

  list(): ViewContext<TUIState>[] {
    return [...this.#views.values()];
  }

  restore(checkpoint: ViewCheckpoint<TUIState>): ViewContext<TUIState> {
    const view: ViewContext<TUIState> = {
      viewId: checkpoint.viewId,
      route: checkpoint.route,
      params: checkpoint.params,
      fanoutScope: checkpoint.fanoutScope ?? "global",
      principal: checkpoint.principal,
      ui: checkpoint.ui,
      projectionVersion: checkpoint.projectionVersion,
      checkpointRevision: checkpoint.checkpointRevision ?? 0,
      cursor: checkpoint.cursor,
      observedRegions: checkpoint.observedRegions,
    };

    this.#views.set(view.viewId, view);
    this.#advanceNextId(view.viewId);
    return view;
  }

  update(view: ViewContext<TUIState>, event: TUIEvent): ViewContext<TUIState> {
    view.ui = this.#definition.update(view.ui, event);
    return view;
  }

  bumpProjection(view: ViewContext<TUIState>): number {
    view.projectionVersion += 1;
    return view.projectionVersion;
  }

  checkpoint(view: ViewContext<TUIState>): ViewCheckpoint<TUIState> {
    return {
      checkpointVersion: VIEW_CHECKPOINT_VERSION,
      viewId: view.viewId,
      route: view.route,
      params: view.params,
      fanoutScope: view.fanoutScope,
      principal: view.principal,
      ui: view.ui,
      projectionVersion: view.projectionVersion,
      checkpointRevision: view.checkpointRevision,
      cursor: view.cursor,
      observedRegions: view.observedRegions,
    };
  }

  #advanceNextId(viewId: string): void {
    const match = /^view-(\d+)$/.exec(viewId);

    if (!match) {
      return;
    }

    this.#nextId = Math.max(this.#nextId, Number(match[1]) + 1);
  }
}

export type ViewCheckpoint<TUIState> = {
  checkpointVersion: number;
  viewId: string;
  route: string;
  params: Record<string, string>;
  fanoutScope?: string;
  principal?: InvocationPrincipal;
  ui: TUIState;
  projectionVersion: number;
  checkpointRevision?: number;
  cursor: string | null;
  observedRegions: ProjectionRegionSnapshot[];
};
