import { screenRouteDefinition, screenRoutePattern, type Program } from "../program";

export function createRuntimeRouter<
  R,
  TUIState,
  TUIEvent extends { type: string },
  TActionInput extends { type: string },
  TProjection,
>(
  program: Program<R, TUIState, TUIEvent, TActionInput, TProjection>,
  runRouteHooks: (
    route: string,
    params: Record<string, string>,
    matchedRoute: string | null,
  ) => Promise<void>,
) {
  function resolveScreen(route: string) {
    return (
      program.screenByRoute.get(route) ?? (program.screens.length === 1 ? program.screens[0] : null)
    );
  }

  async function resolveRoute(route: string, params: Record<string, string>) {
    const exact = program.screenByRoute.get(route);

    if (exact) {
      const definition = screenRouteDefinition(exact);
      const matched = definition?.match(route, params);

      const resolved = {
        route: screenRoutePattern(exact),
        params: matched?.params ?? params,
      };
      await runRouteHooks(route, resolved.params, resolved.route);
      return resolved;
    }

    for (const screen of program.screens) {
      const definition = screenRouteDefinition(screen);
      const matched = definition?.match(route, params);

      if (matched) {
        await runRouteHooks(route, matched.params, matched.route);
        return matched;
      }
    }

    await runRouteHooks(route, params, null);
    return null;
  }

  return {
    resolveScreen,
    resolveRoute,
  };
}
