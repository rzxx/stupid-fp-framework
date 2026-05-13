import type { JsonValue } from "./json";

export type ResourceKey<TValue = unknown> = {
  readonly type: string;
  readonly id: string;
  readonly label: string;
  readonly __value?: TValue;
};

export type ResourceLoader<TServices, TValue> = (
  services: TServices,
  key: ResourceKey<TValue>,
) => Promise<TValue> | TValue;

export type ResourceDefinition<TServices, TValue> = {
  readonly type: string;
  readonly load: ResourceLoader<TServices, TValue>;
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

export function defineResource<TServices, TValue>(
  type: string,
  load: ResourceLoader<TServices, TValue>,
): ResourceDefinition<TServices, TValue> {
  return { type, load };
}

export class ResourceGraph<TServices> {
  readonly #definitions = new Map<string, ResourceDefinition<TServices, unknown>>();
  readonly #cache = new Map<string, ResourceSnapshot>();

  register<TValue>(definition: ResourceDefinition<TServices, TValue>): void {
    this.#definitions.set(definition.type, definition as ResourceDefinition<TServices, unknown>);
  }

  async read<TValue>(services: TServices, key: ResourceKey<TValue>): Promise<TValue> {
    const id = resourceKeyId(key);
    const cached = this.#cache.get(id);

    if (cached) {
      return cached.value as TValue;
    }

    const definition = this.#definitions.get(key.type);

    if (!definition) {
      throw new Error(`No resource registered for ${key.type}`);
    }

    const value = (await definition.load(services, key)) as TValue;
    this.#cache.set(id, { key, value });
    return value;
  }

  invalidate(keys: readonly ResourceKey[]): void {
    for (const key of keys) {
      this.#cache.delete(resourceKeyId(key));
    }
  }

  clear(): void {
    this.#cache.clear();
  }
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
