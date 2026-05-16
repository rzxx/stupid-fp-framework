import type { ResumeResult, ServerEnvelope } from "./stream";
import type { RuntimeStore } from "./store";
import type { TraceSnapshot } from "./trace";
import type { ViewCheckpoint } from "./view";
import { sameParams } from "./runtime-observation";

export async function resolveResume<TUIState, TProjection>(
  input: {
    route: string;
    params: Record<string, string>;
    resume: { viewId: string; cursor: string };
  },
  store: RuntimeStore<TUIState, TProjection, TraceSnapshot>,
  runStore: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<{
  snapshot?: ViewCheckpoint<TUIState>;
  result: ResumeResult;
  replay?: ServerEnvelope<TProjection, TraceSnapshot>[];
}> {
  const snapshot = await runStore(() => store.loadView(input.resume.viewId));

  if (!snapshot) {
    return { result: { status: "rejected", reason: "missing-view" } };
  }

  if (snapshot.route !== input.route || !sameParams(snapshot.params, input.params)) {
    return { result: { status: "rejected", reason: "route-mismatch" } };
  }

  const cursorExists = await runStore(() =>
    store.hasEnvelopeCursor(input.resume.viewId, input.resume.cursor),
  );

  if (!cursorExists) {
    return {
      snapshot,
      result: { status: "refreshed", reason: "stale-cursor" },
    };
  }

  const replay = await runStore(() =>
    store.readEnvelopesAfter(input.resume.viewId, input.resume.cursor),
  );

  if (replay.length === 0) {
    return {
      snapshot,
      result: { status: "refreshed", reason: "current-cursor" },
    };
  }

  return {
    snapshot,
    result: { status: "replayed", replayed: replay.length },
    replay: replay.map((entry) => entry.envelope),
  };
}
