import type { ProjectionRegionSnapshot } from "./projection";
import type { UIStateDefinition } from "./ui-state";

export const VIEW_CHECKPOINT_VERSION = 1;

export type ViewContext<TUIState> = {
  viewId: string;
  route: string;
  params: Record<string, string>;
  ui: TUIState;
  projectionVersion: number;
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

  create(route: string, params: Record<string, string>): ViewContext<TUIState> {
    const viewId = `view-${this.#nextId++}`;
    const view: ViewContext<TUIState> = {
      viewId,
      route,
      params,
      ui: this.#definition.init(),
      projectionVersion: 0,
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
      ui: checkpoint.ui,
      projectionVersion: checkpoint.projectionVersion,
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
      ui: view.ui,
      projectionVersion: view.projectionVersion,
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
  ui: TUIState;
  projectionVersion: number;
  cursor: string | null;
  observedRegions: ProjectionRegionSnapshot[];
};
