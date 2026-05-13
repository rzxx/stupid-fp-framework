import { Effect } from "effect";
import type { JsonRecord } from "./json";
import type { ResourceKey } from "./resource";
import type { TraceSnapshot, TraceStore } from "./trace";

export type ActionFailure = {
  message: string;
  detail?: JsonRecord;
};

export type ActionContext<TServices> = {
  services: TServices;
  trace: TraceSnapshot;
  traces: TraceStore;
  invalidate: (key: ResourceKey) => void;
};

export type ActionEffect = Effect.Effect<void, ActionFailure, never>;

export type ActionDefinition<TServices, TMessage> = {
  type: string;
  run: (message: TMessage, context: ActionContext<TServices>) => ActionEffect;
};

export type ActionExecution = {
  ok: boolean;
  error?: string;
  invalidated: ResourceKey[];
};

export function actionFailure(message: string, detail?: JsonRecord): ActionFailure {
  return { message, detail };
}

export function defineAction<TServices, TMessage extends { type: string }>(
  type: TMessage["type"],
  run: (message: TMessage, context: ActionContext<TServices>) => ActionEffect,
): ActionDefinition<TServices, TMessage> {
  return { type, run };
}

export async function executeAction<TServices, TMessage extends { type: string }>(
  action: ActionDefinition<TServices, TMessage>,
  message: TMessage,
  services: TServices,
  traces: TraceStore,
  trace: TraceSnapshot,
): Promise<ActionExecution> {
  const invalidated: ResourceKey[] = [];
  const context: ActionContext<TServices> = {
    services,
    trace,
    traces,
    invalidate: (key) => {
      invalidated.push(key);
      traces.add(trace, "resource", `${key.label} invalidated`, {
        resourceType: key.type,
        resourceId: key.id,
      });
    },
  };

  traces.add(trace, "action", `${String(action.type)} started`);

  const result = await Effect.runPromiseExit(action.run(message, context));

  if (result._tag === "Failure") {
    const message = String(result.cause);
    traces.fail(trace, message);
    return { ok: false, error: message, invalidated };
  }

  traces.complete(trace);
  return { ok: true, invalidated };
}
