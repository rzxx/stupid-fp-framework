import { Schema } from "./effect";

export type FrameworkSchema<T> = Schema.Schema<T> | object;

export type SchemaDecodeResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      message: string;
    };

export function decodeUnknown<T>(
  schema: FrameworkSchema<T>,
  value: unknown,
): SchemaDecodeResult<T> {
  const decoded = Schema.decodeUnknownEither(schema as Schema.Schema<T>)(value);

  if (decoded._tag === "Right") {
    return { ok: true, value: decoded.right };
  }

  return { ok: false, message: decoded.left.message };
}

export function acceptsSchema<T>(schema: FrameworkSchema<T>): (value: unknown) => value is T {
  return (value): value is T => decodeUnknown(schema, value).ok;
}
