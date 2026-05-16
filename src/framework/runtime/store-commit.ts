import type { RuntimeStore } from "../store";
import type { ServerEnvelope } from "../stream";
import type { TraceSnapshot } from "../trace";
import type { LiveViewRegistry, ViewContext } from "../view";

export type RuntimeInputRecord = {
  clientInputId: string;
  viewId: string;
  status: "accepted" | "committed" | "failed";
};

export async function persistEnvelope<TUIState, TUIEvent, TProjection>(
  input: {
    store: RuntimeStore<TUIState, TProjection, TraceSnapshot>;
    views: LiveViewRegistry<TUIState, TUIEvent>;
    view: ViewContext<TUIState>;
    envelope: ServerEnvelope<TProjection, TraceSnapshot>;
    inputRecord?: RuntimeInputRecord;
  },
  runStore: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const committed = await runStore(() =>
    input.store.commitInvocation({
      envelopes: [{ viewId: input.view.viewId, envelope: input.envelope }],
      views: [
        {
          checkpoint: input.views.checkpoint(input.view),
          expectedRevision: input.view.checkpointRevision,
        },
      ],
      observations: [
        {
          fanoutScope: input.view.fanoutScope,
          viewId: input.view.viewId,
          regions: input.view.observedRegions,
        },
      ],
      inputRecords: input.inputRecord ? [input.inputRecord] : [],
    }),
  );
  const committedEnvelope = committed.envelopes[0]?.envelope;
  const committedView = committed.views[0];

  if (committedEnvelope) {
    Object.assign(input.envelope, committedEnvelope);
  }

  if (committedView) {
    input.view.cursor = committedView.cursor;
    input.view.checkpointRevision =
      committedView.checkpointRevision ?? input.view.checkpointRevision;
    input.view.fanoutScope = committedView.fanoutScope ?? input.view.fanoutScope;
  }
}
