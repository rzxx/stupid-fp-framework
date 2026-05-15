import { Context } from "./effect";

export type InvocationPrincipal = {
  id: string;
  displayName?: string;
  roles?: readonly string[];
};

export type InvocationContextValue = {
  requestId: string;
  fanoutScope: string;
  principal?: InvocationPrincipal;
  clientInputId?: string;
};

export type InvocationProtocolEvent =
  | {
      type: "view.connected";
      viewId: string;
    }
  | {
      type: "projection.updated";
      viewId: string;
      projectionVersion: number;
    }
  | {
      type: "projection.patched";
      viewId: string;
      projectionVersion: number;
      regions: string[];
    }
  | {
      type: "action.result";
      viewId: string;
      ok: boolean;
      clientInputId?: string;
    }
  | {
      type: "trace.updated";
      viewId: string;
      traceId: string;
    }
  | {
      type: "runtime.error";
      viewId?: string;
      message: string;
    };

export type DeliveryIntent<TEnvelope> = {
  viewId: string;
  envelope: TEnvelope;
};

export class InvocationContext extends Context.Tag("stupid-fp/InvocationContext")<
  InvocationContext,
  InvocationContextValue
>() {}

export function defaultInvocationContext(
  options?: Partial<InvocationContextValue>,
): InvocationContextValue {
  return {
    requestId: options?.requestId ?? `request-${crypto.randomUUID()}`,
    fanoutScope: options?.fanoutScope ?? "global",
    principal: options?.principal,
    clientInputId: options?.clientInputId,
  };
}
