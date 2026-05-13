import { Effect } from "./effect";
import type { JsonRecord, JsonValue } from "./json";
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

export type ActionEffect<TResult extends JsonValue | void = void> = Effect.Effect<
  TResult,
  ActionFailure,
  never
>;

type ActionRunner<TServices, TMessage, TResult extends JsonValue | void> = {
  run(message: TMessage, context: ActionContext<TServices>): ActionEffect<TResult>;
}["run"];

export type ActionValidator<TMessage> = (message: unknown) => message is TMessage;

export type ActionDefinition<
  TServices,
  TMessage,
  TResult extends JsonValue | void = JsonValue | void,
> = {
  type: string;
  accepts: ActionValidator<TMessage>;
  run: ActionRunner<TServices, TMessage, TResult>;
};

export type ActionExecution = {
  ok: boolean;
  error?: string;
  result?: JsonValue;
  invalidated: ResourceKey[];
};

export function actionFailure(message: string, detail?: JsonRecord): ActionFailure {
  return { message, detail };
}

export function defineAction<
  TServices,
  TMessage extends { type: string },
  TResult extends JsonValue | void = void,
>(
  type: TMessage["type"],
  accepts: ActionValidator<TMessage>,
  run: (message: TMessage, context: ActionContext<TServices>) => ActionEffect<TResult>,
): ActionDefinition<TServices, TMessage, TResult> {
  return { type, accepts, run };
}

export async function executeAction<TServices, TMessage extends { type: string }>(
  action: ActionDefinition<TServices, TMessage>,
  message: unknown,
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

  if (!action.accepts(message)) {
    const error = `Invalid action payload: ${String(action.type)}`;
    traces.fail(trace, error);
    return { ok: false, error, invalidated };
  }

  const result = await Effect.runPromise(Effect.either(action.run(message, context)));

  if (result._tag === "Left") {
    const message = result.left.message;
    traces.fail(trace, message);
    return { ok: false, error: message, invalidated };
  }

  return {
    ok: true,
    result: result.right === undefined ? undefined : result.right,
    invalidated,
  };
}
