import { AsyncLocalStorage } from "node:async_hooks";
import { Effect } from "./effect";
import type { JsonValue } from "./json";
import type { ProjectionRegionSnapshot } from "./projection";

export type ResourceKey<TValue = unknown> = {
  readonly type: string;
  readonly id: string;
  readonly label: string;
  readonly __value?: TValue;
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
  readonly load: ResourceLoader<R, TValue>;
};

export type ResourceSnapshot<TValue = unknown> = {
  readonly key: ResourceKey<TValue>;
  readonly value: TValue;
};

export type SerializedResourceKey = {
  type: string;
  id: string;
  label: string;
};

export type ResourceObservation = {
  key: SerializedResourceKey;
};

export type ResourceObservationResult<TValue> = {
  value: TValue;
  observed: SerializedResourceKey[];
  regions: ProjectionRegionSnapshot[];
};

export function resourceKey<TValue>(
  type: string,
  id: string,
  label = `${type}(${id})`,
): ResourceKey<TValue> {
  return { type, id, label };
}

export function serializeResourceKey(key: ResourceKey): SerializedResourceKey {
  return { type: key.type, id: key.id, label: key.label };
}

export function resourceKeyId(key: ResourceKey): string {
  return `${key.type}:${key.id}`;
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
): ResourceDefinition<R, TValue> {
  return { type, load };
}

export class ResourceGraph<R> {
  readonly #definitions = new Map<string, ResourceDefinition<R, unknown>>();
  readonly #cache = new Map<string, ResourceSnapshot>();
  readonly #observerStorage = new AsyncLocalStorage<ResourceObservationScope>();

  register<TValue>(definition: ResourceDefinition<R, TValue>): void {
    this.#definitions.set(definition.type, definition as ResourceDefinition<R, unknown>);
  }

  read<TValue>(key: ResourceKey<TValue>): Effect.Effect<TValue, ResourceFailure, R> {
    this.#recordObservation(key);

    const id = resourceKeyId(key);
    const cached = this.#cache.get(id);

    if (cached) {
      return Effect.succeed(cached.value as TValue);
    }

    const definition = this.#definitions.get(key.type);

    if (!definition) {
      return Effect.fail(
        resourceFailure(key.type, `No resource registered for ${key.type}`, key.id),
      );
    }

    return Effect.flatMap(
      Effect.try({
        try: () => definition.load(key) as Effect.Effect<TValue, ResourceFailure, R>,
        catch: (error) =>
          resourceFailure(
            key.type,
            error instanceof Error ? error.message : "Resource loader failed",
            key.id,
          ),
      }),
      (effect) =>
        Effect.tap(effect, (value) =>
          Effect.sync(() => {
            this.#cache.set(id, { key, value });
          }),
        ),
    );
  }

  invalidate(keys: readonly ResourceKey[]): void {
    for (const key of keys) {
      this.#cache.delete(resourceKeyId(key));
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

  #recordObservation(key: ResourceKey): void {
    const observer = this.#observerStorage.getStore();

    if (observer) {
      const region = this.#ensureRegion(observer, observer.regionId);

      region.resources.set(resourceKeyId(key), serializeResourceKey(key));
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
      resources.set(`${resource.type}:${resource.id}`, resource);
    }
  }

  return [...resources.values()];
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
