import { Effect, type ManagedRuntime } from "./effect";
import type { JsonRecord, JsonValue } from "./json";
import type { ActionHooks } from "./plugin";
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

type ActionRunner<R, TInput, TResult extends JsonValue | void> = {
  run(input: TInput, context: ActionContext): ActionEffect<TResult, R>;
}["run"];

export type ActionValidator<TInput> = (input: unknown) => input is TInput;

export type ActionDefinition<R, TInput, TResult extends JsonValue | void = JsonValue | void> = {
  type: string;
  accepts: ActionValidator<TInput>;
  run: ActionRunner<R, TInput, TResult>;
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

export function rejectAction(message: string, detail?: JsonRecord): never {
  throw actionFailure(message, detail);
}

export function defineAction<
  TInput extends { type: string },
  TResult extends JsonValue | void = void,
  R = never,
>(
  type: TInput["type"],
  accepts: ActionValidator<TInput>,
  run: (input: TInput, context: ActionContext) => ActionEffect<TResult, R>,
): ActionDefinition<R, TInput, TResult> {
  return { type, accepts, run };
}

export const Action = {
  reject: rejectAction,
  define<TType extends string>(type: TType) {
    return {
      input<TInput extends { type: TType }>(schema: FrameworkSchema<TInput>) {
        return {
          run<TResult extends JsonValue | void = void>(
            run: (input: TInput, context: ActionContext) => TResult | Promise<TResult>,
          ): ActionDefinition<never, TInput, TResult> {
            return defineAction(type, acceptsSchema(schema), (input, context) =>
              Effect.tryPromise({
                try: () => Promise.resolve(run(input, context)),
                catch: normalizeAsyncActionFailure,
              }),
            );
          },
          runEffect<TResult extends JsonValue | void = void, R = never>(
            run: (input: TInput, context: ActionContext) => ActionEffect<TResult, R>,
          ): ActionDefinition<R, TInput, TResult> {
            return defineAction(type, acceptsSchema(schema), run);
          },
          runAsync<TResult extends JsonValue | void = void>(
            run: (input: TInput, context: ActionContext) => TResult | Promise<TResult>,
          ): ActionDefinition<never, TInput, TResult> {
            return defineAction(type, acceptsSchema(schema), (input, context) =>
              Effect.tryPromise({
                try: () => Promise.resolve(run(input, context)),
                catch: normalizeAsyncActionFailure,
              }),
            );
          },
        };
      },
    };
  },
};

function normalizeAsyncActionFailure(error: unknown): ActionFailure {
  if (isActionFailure(error)) {
    return error;
  }

  return actionFailure(error instanceof Error ? error.message : "Action failed");
}

function isActionFailure(value: unknown): value is ActionFailure {
  return (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

export async function executeAction<R, TInput extends { type: string }>(
  action: ActionDefinition<R, TInput>,
  input: unknown,
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  traces: TraceStore,
  trace: TraceSnapshot,
  hooks: ActionHooks<R>[] = [],
  runEffect?: <A, E, R2>(effect: Effect.Effect<A, E, R2>) => Promise<A>,
): Promise<ActionExecution> {
  const run = <A, E, R2>(effect: Effect.Effect<A, E, R2>) =>
    runEffect
      ? runEffect(effect)
      : runtime.runPromise(effect as unknown as Effect.Effect<A, never, R>);
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

  if (!action.accepts(input)) {
    const error = `Invalid action payload: ${String(action.type)}`;
    traces.fail(trace, error);
    return { ok: false, error, invalidated };
  }

  const actionInput = input as { type: string };

  await run(
    Effect.forEach(
      hooks,
      (hook) =>
        hook.before?.({ actionType: action.type, input: actionInput, trace }) ?? Effect.void,
    ),
  );

  const result = await run(Effect.either(action.run(input, context)));

  if (result._tag === "Left") {
    const message = result.left.message;
    traces.fail(trace, message);
    await run(
      Effect.forEach(
        hooks,
        (hook) =>
          hook.failure?.({
            actionType: action.type,
            input: actionInput,
            trace,
            error: message,
          }) ?? Effect.void,
      ),
    );
    await run(
      Effect.forEach(
        hooks,
        (hook) =>
          hook.after?.({
            actionType: action.type,
            input: actionInput,
            trace,
            ok: false,
          }) ?? Effect.void,
      ),
    );
    return { ok: false, error: message, invalidated };
  }

  await run(
    Effect.forEach(
      hooks,
      (hook) =>
        hook.after?.({
          actionType: action.type,
          input: actionInput,
          trace,
          ok: true,
        }) ?? Effect.void,
    ),
  );

  return {
    ok: true,
    result: result.right === undefined ? undefined : result.right,
    invalidated,
  };
}
