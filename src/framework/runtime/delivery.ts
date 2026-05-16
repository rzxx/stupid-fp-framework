import type { DeliveryIntent, InvocationProtocolEvent } from "../invocation";
import type { ServerEnvelope } from "../stream";
import type { TraceSnapshot } from "../trace";

export type RuntimeResult<TProjection> = {
  envelopes: ServerEnvelope<TProjection, TraceSnapshot>[];
  protocolEvents?: InvocationProtocolEvent[];
  deliveryIntents?: DeliveryIntent<ServerEnvelope<TProjection, TraceSnapshot>>[];
};

export function runtimeResult<TProjection>(
  envelopes: ServerEnvelope<TProjection, TraceSnapshot>[],
): RuntimeResult<TProjection> {
  return {
    envelopes,
    protocolEvents: envelopes.map(protocolEventForEnvelope),
    deliveryIntents: envelopes.flatMap((envelope) =>
      "viewId" in envelope && envelope.viewId ? [{ viewId: envelope.viewId, envelope }] : [],
    ) satisfies DeliveryIntent<ServerEnvelope<TProjection, TraceSnapshot>>[],
  };
}

function protocolEventForEnvelope<TProjection>(
  envelope: ServerEnvelope<TProjection, TraceSnapshot>,
): InvocationProtocolEvent {
  if (envelope.type === "connected") {
    return { type: "view.connected", viewId: envelope.viewId };
  }

  if (envelope.type === "projection:update") {
    return {
      type: "projection.updated",
      viewId: envelope.viewId,
      projectionVersion: envelope.projectionVersion,
    };
  }

  if (envelope.type === "projection:patch") {
    return {
      type: "projection.patched",
      viewId: envelope.viewId,
      projectionVersion: envelope.projectionVersion,
      regions: envelope.patch.regions.map((region) => region.id),
    };
  }

  if (envelope.type === "action:result") {
    return {
      type: "action.result",
      viewId: envelope.viewId,
      ok: envelope.ok,
      clientInputId: envelope.clientInputId,
    };
  }

  if (envelope.type === "action:lifecycle") {
    return {
      type: "action.lifecycle",
      viewId: envelope.viewId,
      stage: envelope.stage,
      clientInputId: envelope.clientInputId,
    };
  }

  if (envelope.type === "trace:update") {
    return {
      type: "trace.updated",
      viewId: envelope.viewId,
      traceId: envelope.trace.traceId,
    };
  }

  return { type: "runtime.error", viewId: envelope.viewId, message: envelope.message };
}
