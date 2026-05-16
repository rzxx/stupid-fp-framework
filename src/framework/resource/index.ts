import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Option } from "../effect";
import {
  InvocationContext,
  defaultInvocationContext,
  type InvocationContextValue,
} from "../invocation";
import type { JsonValue } from "../json";
import type { ProjectionRegionSnapshot, SerializedResourceKey } from "../observation";
import type { ResourceHooks } from "../plugin";

export type ResourceKey<TValue = unknown> = {
  readonly type: string;
  readonly id: string;
  readonly label: string;
  readonly params?: unknown;
  readonly scope?: ResolvedResourceScope;
  readonly __value?: TValue;
};

export type ResourceScopeKind = "global" | "fanout" | "principal" | "custom";

export type ResolvedResourceScope = {
  readonly kind: ResourceScopeKind;
  readonly id: string;
  readonly label: string;
};

export type ResourceScope<TParams = unknown> =
  | {
      readonly kind: "global";
    }
  | {
      readonly kind: "fanout";
    }
  | {
      readonly kind: "principal";
      readonly anonymousId?: string;
    }
  | {
      readonly kind: "custom";
      readonly resolve: (input: {
        readonly context: InvocationContextValue;
        readonly params: TParams;
        readonly key: ResourceKey;
      }) => string | ResolvedResourceScope;
    };

export type ResourceFailure = {
  type: "resource-error";
  resourceType: string;
  resourceId?: string;
  message: string;
};

export type ResourceLoader<R, TValue> = {
  load(key: ResourceKey<TValue>): Effect.Effect<TValue, ResourceFailure, R>;
}["load"];

export type ResourceDefinition<R, TValue> = {
  readonly type: string;
  readonly scope?: ResourceScope;
  readonly load: ResourceLoader<R, TValue>;
};

export type ResourceSnapshot<TValue = unknown> = {
  readonly key: ResourceKey<TValue>;
  readonly value: TValue;
};

export type { ResourceObservation, SerializedResourceKey } from "../observation";

export type ResourceObservationResult<TValue> = {
  value: TValue;
  observed: SerializedResourceKey[];
  regions: ProjectionRegionSnapshot[];
};

export function resourceKey<TValue>(
  type: string,
  id: string,
  label = `${type}(${id})`,
  params?: unknown,
): ResourceKey<TValue> {
  return { type, id, label, params };
}

export function serializeResourceKey(key: ResourceKey): SerializedResourceKey {
  return key.scope && key.scope.kind !== "global"
    ? { type: key.type, id: key.id, label: key.label, scope: serializeResourceScope(key.scope) }
    : { type: key.type, id: key.id, label: key.label };
}

export function resourceKeyId(key: ResourceKey): string {
  return `${key.type}:${key.id}`;
}

export function scopedResourceKeyId(key: ResourceKey): string {
  const scope = key.scope ?? globalResourceScope();
  return `${resourceKeyId(key)}:${scope.kind}:${scope.id}`;
}

export function resourceFailure(
  resourceType: string,
  message: string,
  resourceId?: string,
): ResourceFailure {
  return { type: "resource-error", resourceType, resourceId, message };
}

export function defineResource<R, TValue>(
  type: string,
  load: ResourceLoader<R, TValue>,
  options?: {
    scope?: ResourceScope;
  },
): ResourceDefinition<R, TValue> {
  return { type, scope: options?.scope, load };
}

export type ResourceDeclaration<R, TParams, TValue> = ResourceDefinition<R, TValue> & {
  key: (params: TParams) => ResourceKey<TValue>;
};

export const Resource = {
  define<TType extends string>(type: TType) {
    return new ResourceBuilder<unknown>(type);
  },
};

class ResourceBuilder<TValue> {
  readonly #type: string;
  readonly #scope: ResourceScope | undefined;

  constructor(type: string, scope?: ResourceScope) {
    this.#type = type;
    this.#scope = scope;
  }

  value<TNextValue>(): ResourceBuilder<TNextValue> {
    return new ResourceBuilder<TNextValue>(this.#type, this.#scope);
  }

  scope(scope: ResourceScope): ResourceBuilder<TValue> {
    return new ResourceBuilder<TValue>(this.#type, scope);
  }

  key<TParams>(
    _schema: unknown,
    options: {
      id: (params: TParams) => string;
      label?: (params: TParams) => string;
    },
  ) {
    return {
      load: (
        load: (params: TParams, key: ResourceKey<TValue>) => TValue | Promise<TValue>,
      ): ResourceDeclaration<never, TParams, TValue> => ({
        type: this.#type,
        scope: this.#scope,
        key: (params) => {
          const id = options.id(params);
          return resourceKey(
            this.#type,
            id,
            options.label?.(params) ?? `${this.#type}(${id})`,
            params,
          );
        },
        load: (key) =>
          Effect.tryPromise({
            try: () => Promise.resolve(load(key.params as TParams, key as ResourceKey<TValue>)),
            catch: (error) =>
              resourceFailure(
                this.#type,
                error instanceof Error ? error.message : "Resource loader failed",
                key.id,
              ),
          }),
      }),
      loadEffect: <R>(
        load: (
          params: TParams,
          key: ResourceKey<TValue>,
        ) => Effect.Effect<TValue, ResourceFailure, R>,
      ): ResourceDeclaration<R, TParams, TValue> => ({
        type: this.#type,
        scope: this.#scope,
        key: (params) => {
          const id = options.id(params);
          return resourceKey(
            this.#type,
            id,
            options.label?.(params) ?? `${this.#type}(${id})`,
            params,
          );
        },
        load: (key) => load(key.params as TParams, key as ResourceKey<TValue>),
      }),
    };
  }
}

export class ResourceGraph<R> {
  readonly #definitions = new Map<string, ResourceDefinition<R, unknown>>();
  readonly #cache = new Map<string, ResourceSnapshot>();
  readonly #observerStorage = new AsyncLocalStorage<ResourceObservationScope>();
  readonly #hooks: ResourceHooks<R>[];

  constructor(hooks: ResourceHooks<R>[] = []) {
    this.#hooks = hooks;
  }

  register<TValue>(definition: ResourceDefinition<R, TValue>): void {
    this.#definitions.set(definition.type, definition as ResourceDefinition<R, unknown>);
  }

  read<TValue>(key: ResourceKey<TValue>): Effect.Effect<TValue, ResourceFailure, R> {
    const definition = this.#definitions.get(key.type);

    if (!definition) {
      return Effect.fail(
        resourceFailure(key.type, `No resource registered for ${key.type}`, key.id),
      );
    }

    return Effect.flatMap(
      Effect.map(Effect.serviceOption(InvocationContext), (option) =>
        Option.getOrElse(option, () => defaultInvocationContext()),
      ),
      (invocation) => {
        const scopedKey = withResolvedResourceScope(
          key,
          resolveResourceScope(definition.scope, key, invocation),
        );
        this.#recordObservation(scopedKey);

        const id = scopedResourceKeyId(scopedKey);
        const cached = this.#cache.get(id);

        if (cached) {
          return Effect.as(
            Effect.forEach(
              this.#hooks,
              (hook) => hook.afterRead?.({ key: serializeResourceKey(scopedKey) }) ?? Effect.void,
            ),
            cached.value as TValue,
          );
        }

        const read = Effect.flatMap(
          Effect.forEach(
            this.#hooks,
            (hook) => hook.beforeRead?.({ key: serializeResourceKey(scopedKey) }) ?? Effect.void,
          ),
          () =>
            Effect.flatMap(
              Effect.try({
                try: () => definition.load(scopedKey) as Effect.Effect<TValue, ResourceFailure, R>,
                catch: (error) =>
                  resourceFailure(
                    key.type,
                    error instanceof Error ? error.message : "Resource loader failed",
                    key.id,
                  ),
              }),
              (effect) => effect,
            ),
        );

        return Effect.tapError(
          Effect.tap(read, (value) =>
            Effect.zipRight(
              Effect.sync(() => {
                this.#cache.set(id, { key: scopedKey, value });
              }),
              Effect.forEach(
                this.#hooks,
                (hook) => hook.afterRead?.({ key: serializeResourceKey(scopedKey) }) ?? Effect.void,
              ),
            ),
          ),
          (failure) =>
            Effect.forEach(
              this.#hooks,
              (hook) =>
                hook.failure?.({ key: serializeResourceKey(scopedKey), error: failure.message }) ??
                Effect.void,
            ),
        );
      },
    );
  }

  async readAsync<TValue>(key: ResourceKey<TValue>): Promise<TValue> {
    return Effect.runPromise(this.read(key) as Effect.Effect<TValue, never, never>);
  }

  invalidate(keys: readonly ResourceKey[]): void {
    for (const key of keys) {
      const baseId = `${resourceKeyId(key)}:`;

      for (const cacheId of this.#cache.keys()) {
        if (cacheId.startsWith(baseId)) {
          this.#cache.delete(cacheId);
        }
      }
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  async observe<TValue>(
    read: () => Promise<TValue> | TValue,
  ): Promise<ResourceObservationResult<TValue>> {
    const scope: ResourceObservationScope = {
      regionId: "root",
      regions: new Map(),
    };

    return this.#observerStorage.run(scope, async () => {
      const value = await Promise.resolve(read());
      const regions = [...scope.regions.entries()].map(([id, region]) => ({
        id,
        value: region.value,
        resources: [...region.resources.values()],
      }));
      const observed = uniqueResources(regions);

      return { value, observed, regions };
    });
  }

  region<TValue, E>(
    id: string,
    read: () => Effect.Effect<TValue, E, R>,
  ): Effect.Effect<TValue, E, R> {
    const observer = this.#observerStorage.getStore();

    if (!observer) {
      return read();
    }

    const previous = observer.regionId;
    observer.regionId = id;

    return Effect.ensuring(
      Effect.tap(read(), (value) =>
        Effect.sync(() => {
          const region = this.#ensureRegion(observer, id);

          if (isJsonValue(value)) {
            region.value = value;
          }
        }),
      ),
      Effect.sync(() => {
        observer.regionId = previous;
      }),
    );
  }

  async regionAsync<TValue>(id: string, read: () => Promise<TValue> | TValue): Promise<TValue> {
    const observer = this.#observerStorage.getStore();

    if (!observer) {
      return read();
    }

    const previous = observer.regionId;
    observer.regionId = id;

    try {
      const value = await read();
      const region = this.#ensureRegion(observer, id);

      if (isJsonValue(value)) {
        region.value = value;
      }

      return value;
    } finally {
      observer.regionId = previous;
    }
  }

  #recordObservation(key: ResourceKey): void {
    const observer = this.#observerStorage.getStore();

    if (observer) {
      const region = this.#ensureRegion(observer, observer.regionId);

      region.resources.set(scopedResourceKeyId(key), serializeResourceKey(key));
    }
  }

  #ensureRegion(
    observer: ResourceObservationScope,
    id: string,
  ): {
    value?: JsonValue;
    resources: Map<string, SerializedResourceKey>;
  } {
    let region = observer.regions.get(id);

    if (!region) {
      region = { resources: new Map() };
      observer.regions.set(id, region);
    }

    return region;
  }
}

type ResourceObservationScope = {
  regionId: string;
  regions: Map<
    string,
    {
      value?: JsonValue;
      resources: Map<string, SerializedResourceKey>;
    }
  >;
};

function uniqueResources(regions: ProjectionRegionSnapshot[]): SerializedResourceKey[] {
  const resources = new Map<string, SerializedResourceKey>();

  for (const region of regions) {
    for (const resource of region.resources) {
      const scope = resource.scope;
      resources.set(
        scope
          ? `${resource.type}:${resource.id}:${scope.kind}:${scope.id}`
          : `${resource.type}:${resource.id}`,
        resource,
      );
    }
  }

  return [...resources.values()];
}

function resolveResourceScope(
  declaration: ResourceScope | undefined,
  key: ResourceKey,
  context: InvocationContextValue,
): ResolvedResourceScope {
  const scope = declaration ?? { kind: "global" };

  if (scope.kind === "global") {
    return globalResourceScope();
  }

  if (scope.kind === "fanout") {
    return {
      kind: "fanout",
      id: context.fanoutScope,
      label: `fanout:${context.fanoutScope}`,
    };
  }

  if (scope.kind === "principal") {
    const id = context.principal?.id ?? scope.anonymousId ?? "anonymous";

    return {
      kind: "principal",
      id,
      label: context.principal ? "principal:authenticated" : "principal:anonymous",
    };
  }

  const custom = scope.resolve({
    context,
    params: key.params,
    key,
  });

  return typeof custom === "string"
    ? {
        kind: "custom",
        id: custom,
        label: "custom",
      }
    : custom;
}

function globalResourceScope(): ResolvedResourceScope {
  return { kind: "global", id: "global", label: "global" };
}

function withResolvedResourceScope<TValue>(
  key: ResourceKey<TValue>,
  scope: ResolvedResourceScope,
): ResourceKey<TValue> {
  return { ...key, scope };
}

function serializeResourceScope(scope: ResolvedResourceScope): SerializedResourceKey["scope"] {
  if (scope.kind === "principal") {
    return {
      kind: scope.kind,
      id: scope.id === "anonymous" ? "anonymous" : "authenticated",
      label: scope.label,
    };
  }

  if (scope.kind === "custom") {
    return {
      kind: scope.kind,
      id: "custom",
      label: scope.label,
    };
  }

  return scope;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(
      (entry) => entry === undefined || isJsonValue(entry),
    );
  }

  return false;
}
