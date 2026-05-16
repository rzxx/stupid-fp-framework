import type { InvocationContextValue } from "../invocation";
import type { ServerEnvelope } from "../stream";
import type { TraceSnapshot, TraceStore } from "../trace";
import type { LiveViewRegistry, ViewContext } from "../view";

export function createTraceEmitter<TUIState, TUIEvent, TProjection>(deps: {
  views: LiveViewRegistry<TUIState, TUIEvent>;
  traces: TraceStore;
  persistEnvelope: (
    view: ViewContext<TUIState>,
    envelope: ServerEnvelope<TProjection, TraceSnapshot>,
  ) => Promise<void>;
  runTraceHooks: (trace: TraceSnapshot, invocation: InvocationContextValue) => Promise<void>;
}) {
  async function traceEnvelope(
    view: ViewContext<TUIState>,
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>> {
    await deps.runTraceHooks(trace, invocation);
    const envelope: ServerEnvelope<TProjection, TraceSnapshot> = {
      type: "trace:update",
      viewId: view.viewId,
      cursor: "",
      trace: deps.traces.snapshot(trace, "browser"),
    };
    await deps.persistEnvelope(view, envelope);
    return envelope;
  }

  async function traceEnvelopesFor(
    initiatingView: ViewContext<TUIState>,
    envelopes: ServerEnvelope<TProjection, TraceSnapshot>[],
    trace: TraceSnapshot,
    invocation: InvocationContextValue,
  ): Promise<ServerEnvelope<TProjection, TraceSnapshot>[]> {
    const targetViewIds = new Set([initiatingView.viewId]);

    for (const envelope of envelopes) {
      if ("viewId" in envelope && envelope.viewId) {
        targetViewIds.add(envelope.viewId);
      }
    }

    const traceEnvelopes: ServerEnvelope<TProjection, TraceSnapshot>[] = [];

    for (const viewId of targetViewIds) {
      const targetView = deps.views.get(viewId);

      if (targetView) {
        traceEnvelopes.push(await traceEnvelope(targetView, trace, invocation));
      }
    }

    return traceEnvelopes;
  }

  return {
    traceEnvelope,
    traceEnvelopesFor,
  };
}
