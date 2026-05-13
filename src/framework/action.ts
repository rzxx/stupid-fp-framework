import { Effect } from "./effect";
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

type ActionRunner<TServices, TMessage> = {
  run(message: TMessage, context: ActionContext<TServices>): ActionEffect;
}["run"];

export type ActionDefinition<TServices, TMessage> = {
  type: string;
  run: ActionRunner<TServices, TMessage>;
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

  const result = await Effect.runPromise(Effect.either(action.run(message, context)));

  if (result._tag === "Left") {
    const message = result.left.message;
    traces.fail(trace, message);
    return { ok: false, error: message, invalidated };
  }

  return { ok: true, invalidated };
}
