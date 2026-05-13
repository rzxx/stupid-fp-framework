import { Effect, type ManagedRuntime } from "./effect";
import type { JsonRecord, JsonValue } from "./json";
import type { ResourceKey } from "./resource";
import { acceptsSchema, type FrameworkSchema } from "./schema";
import type { TraceSnapshot, TraceStore } from "./trace";

export type ActionFailure = {
  message: string;
  detail?: JsonRecord;
};

export type ActionContext = {
  trace: TraceSnapshot;
  traces: TraceStore;
  invalidate: (key: ResourceKey) => void;
};

export type ActionEffect<TResult extends JsonValue | void = void, R = never> = Effect.Effect<
  TResult,
  ActionFailure,
  R
>;

type ActionRunner<R, TMessage, TResult extends JsonValue | void> = {
  run(message: TMessage, context: ActionContext): ActionEffect<TResult, R>;
}["run"];

export type ActionValidator<TMessage> = (message: unknown) => message is TMessage;

export type ActionDefinition<R, TMessage, TResult extends JsonValue | void = JsonValue | void> = {
  type: string;
  accepts: ActionValidator<TMessage>;
  run: ActionRunner<R, TMessage, TResult>;
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
  TMessage extends { type: string },
  TResult extends JsonValue | void = void,
  R = never,
>(
  type: TMessage["type"],
  accepts: ActionValidator<TMessage>,
  run: (message: TMessage, context: ActionContext) => ActionEffect<TResult, R>,
): ActionDefinition<R, TMessage, TResult> {
  return { type, accepts, run };
}

export const Action = {
  define<TType extends string>(type: TType) {
    return {
      input<TMessage extends { type: TType }>(schema: FrameworkSchema<TMessage>) {
        return {
          run<TResult extends JsonValue | void = void, R = never>(
            run: (message: TMessage, context: ActionContext) => ActionEffect<TResult, R>,
          ): ActionDefinition<R, TMessage, TResult> {
            return defineAction(type, acceptsSchema(schema), run);
          },
        };
      },
    };
  },
};

export async function executeAction<R, TMessage extends { type: string }>(
  action: ActionDefinition<R, TMessage>,
  message: unknown,
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  traces: TraceStore,
  trace: TraceSnapshot,
): Promise<ActionExecution> {
  const invalidated: ResourceKey[] = [];
  const context: ActionContext = {
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

  const result = await runtime.runPromise(Effect.either(action.run(message, context)));

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
