import { defaultInvocationContext } from "../invocation";
import type { RuntimeStore } from "../store";
import type { TraceSnapshot } from "../trace";
import type { LiveViewRegistry, ViewContext } from "../view";

export function createViewRestorer<TUIState, TUIEvent, TProjection>(deps: {
  store: RuntimeStore<TUIState, TProjection, TraceSnapshot>;
  views: LiveViewRegistry<TUIState, TUIEvent>;
  runStore: <T>(operation: () => Promise<T>) => Promise<T>;
  runViewHooks: (
    kind: "create" | "restore",
    view: ViewContext<TUIState>,
    invocation: ReturnType<typeof defaultInvocationContext>,
  ) => Promise<void>;
}) {
  async function restoreViewForReceive(viewId: string): Promise<ViewContext<TUIState> | undefined> {
    const snapshot = await deps.runStore(() => deps.store.loadView(viewId));

    if (!snapshot) {
      return undefined;
    }

    const view = deps.views.restore(snapshot);
    await deps.runViewHooks(
      "restore",
      view,
      defaultInvocationContext({ fanoutScope: view.fanoutScope, principal: view.principal }),
    );
    return view;
  }

  async function restoreCheckpointedViews(): Promise<ViewContext<TUIState>[]> {
    const snapshots = await deps.runStore(() => deps.store.listViews());

    for (const snapshot of snapshots) {
      if (!deps.views.get(snapshot.viewId)) {
        const view = deps.views.restore(snapshot);
        await deps.runViewHooks(
          "restore",
          view,
          defaultInvocationContext({ fanoutScope: view.fanoutScope, principal: view.principal }),
        );
      }
    }

    return deps.views.list();
  }

  return {
    restoreViewForReceive,
    restoreCheckpointedViews,
  };
}
