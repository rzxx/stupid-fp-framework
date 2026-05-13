import { executeAction } from "./action";
import type { Program } from "./program";
import { serializeResourceKey } from "./resource";
import { type ClientEnvelope, type ServerEnvelope } from "./stream";
import { SessionStore } from "./session";
import { TraceStore, type TraceSnapshot } from "./trace";

export type RuntimeResult<TProjection> = {
  envelopes: ServerEnvelope<TProjection, TraceSnapshot>[];
};

export type Runtime<
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
> = {
  connect: (
    envelope: Extract<ClientEnvelope<TSessionMessage | TActionMessage>, { type: "connect" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  receive: (
    envelope: Extract<ClientEnvelope<TSessionMessage | TActionMessage>, { type: "message" }>,
  ) => Promise<RuntimeResult<TProjection>>;
  traces: TraceStore;
};

export function createRuntime<
  TServices,
  TSessionState,
  TSessionMessage extends { type: string },
  TActionMessage extends { type: string },
  TProjection,
>(
  program: Program<TServices, TSessionState, TSessionMessage, TActionMessage, TProjection>,
): Runtime<TSessionMessage, TActionMessage, TProjection> {
  const sessions = new SessionStore(program.session);
  const traces = new TraceStore();

  async function project(
    sessionId: string,
    trace?: TraceSnapshot,
  ): Promise<RuntimeResult<TProjection>> {
    const session = sessions.get(sessionId);

    if (!session) {
      return {
        envelopes: [{ type: "error", sessionId, message: "Unknown session" }],
      };
    }

    const observed = await program.resourceGraph.observe(() =>
      program.screen.project(session, {
        services: program.services,
        resources: program.resourceGraph,
        traces: traces.scoped(sessionId),
      }),
    );

    if (trace) {
      traces.add(trace, "projection", "resources observed", {
        resources: observed.observed.map((resource) => resource.label),
      });
      traces.add(trace, "projection", "projection recomputed");
    }

    const projection = observed.value;
    const projectionVersion = sessions.bumpProjection(session);

    if (trace) {
      traces.add(trace, "stream", "projection streamed", {
        projectionVersion,
        observedResources: observed.observed.map((resource) => resource.label),
      });
    }

    return {
      envelopes: [
        {
          type: "projection:update",
          sessionId,
          projectionVersion,
          projection,
        },
      ],
    };
  }

  return {
    traces,

    async connect(envelope) {
      const session = sessions.create(envelope.route, envelope.params);
      const initial = await project(session.sessionId);

      return {
        envelopes: [{ type: "connected", sessionId: session.sessionId }, ...initial.envelopes],
      };
    },

    async receive(envelope) {
      const session = sessions.get(envelope.sessionId);

      if (!session) {
        return {
          envelopes: [
            {
              type: "error",
              sessionId: envelope.sessionId,
              message: "Unknown session",
            },
          ],
        };
      }

      const trace = traces.start(envelope.message.type, {
        scopeId: session.sessionId,
      });
      traces.add(trace, "message", "message received", {
        messageType: envelope.message.type,
      });

      const action = program.actionByType.get(envelope.message.type);

      if (!action) {
        sessions.update(session, envelope.message as TSessionMessage);
        traces.add(trace, "session", `${envelope.message.type} applied`);
        const projected = await project(session.sessionId, trace);
        traces.complete(trace);

        return {
          envelopes: [
            ...projected.envelopes,
            { type: "trace:update", sessionId: session.sessionId, trace },
          ],
        };
      }

      const result = await executeAction(
        action,
        envelope.message as TActionMessage,
        program.services,
        traces,
        trace,
      );

      program.resourceGraph.invalidate(result.invalidated);

      traces.add(trace, "resource", "resources invalidated", {
        resources: result.invalidated.map((key) => serializeResourceKey(key).label),
      });
      const projected = await project(session.sessionId, trace);

      if (result.ok) {
        traces.complete(trace);
      }

      return {
        envelopes: [
          {
            type: "action:result",
            sessionId: session.sessionId,
            traceId: trace.traceId,
            action: envelope.message.type.replace(/^action\./, ""),
            ok: result.ok,
            error: result.error,
          },
          ...projected.envelopes,
          { type: "trace:update", sessionId: session.sessionId, trace },
        ],
      };
    },
  };
}
