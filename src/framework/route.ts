import { decodeUnknown, type FrameworkSchema } from "./schema";

export type RouteDefinition<TParams extends Record<string, string> = Record<string, string>> = {
  id: string;
  pattern: string;
  params: FrameworkSchema<unknown>;
  match: (path: string, suppliedParams?: Record<string, string>) => RouteMatch<TParams> | null;
};

export type RouteMatch<TParams extends Record<string, string> = Record<string, string>> = {
  route: string;
  params: TParams;
};

export function defineRoute<TParams extends Record<string, string>>(
  pattern: string,
  options: {
    id?: string;
    params: FrameworkSchema<TParams>;
  },
): RouteDefinition<TParams> {
  const segments = pattern.split("/").filter(Boolean);

  return {
    id: options.id ?? pattern,
    pattern,
    params: options.params as FrameworkSchema<unknown>,
    match(path, suppliedParams = {}) {
      const pathSegments = path.split("/").filter(Boolean);
      const params: Record<string, string> = { ...suppliedParams };

      if (path === pattern) {
        return decodeRouteParams(pattern, options.params, params);
      }

      if (segments.length !== pathSegments.length) {
        return null;
      }

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const pathSegment = pathSegments[index];

        if (segment?.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(pathSegment ?? "");
          continue;
        }

        if (segment !== pathSegment) {
          return null;
        }
      }

      return decodeRouteParams(pattern, options.params, params);
    },
  };
}

export const Route = {
  define: defineRoute,
};

function decodeRouteParams<TParams extends Record<string, string>>(
  pattern: string,
  schema: FrameworkSchema<TParams>,
  params: Record<string, string>,
): RouteMatch<TParams> | null {
  const decoded = decodeUnknown(schema, params);

  if (!decoded.ok) {
    return null;
  }

  return { route: pattern, params: decoded.value };
}
