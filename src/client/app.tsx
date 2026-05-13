import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import type { TraceSnapshot } from "../framework";
import type { ApprovalClientMessage, ApprovalProjection } from "../demo/approvals/types";
import { applyRegionValuePatch } from "./projection-patch";
import { useProgramStream, type ProgramStreamReactOptions } from "./react-adapter";

function App() {
  const [deploymentFilter, setDeploymentFilter] = useState("");
  const streamOptions = useMemo<
    ProgramStreamReactOptions<ApprovalProjection, TraceSnapshot>
  >(() => {
    return {
      route: "/teams/:teamId/deployments",
      params: { teamId: "team-platform" },
      storageKey: "approval-stream",
      projectionTraces: (projection) => projection.traces,
      applyPatch: (projection, patch) =>
        applyRegionValuePatch(projection, patch, {
          pendingDeployments: (current, value) =>
            Array.isArray(value)
              ? {
                  ...current,
                  pendingDeployments: value as ApprovalProjection["pendingDeployments"],
                }
              : current,
          selectedDeployment: (current, value) => ({
            ...current,
            selectedDeployment: value as ApprovalProjection["selectedDeployment"],
          }),
          tracePanel: (current, value) =>
            Array.isArray(value)
              ? { ...current, traces: value as ApprovalProjection["traces"] }
              : current,
        }),
    };
  }, []);
  const stream = useProgramStream<ApprovalClientMessage, ApprovalProjection, TraceSnapshot>(
    streamOptions,
  );

  const selectedId = stream.projection?.selectedDeployment?.id ?? null;
  const selectedIsPending = stream.projection?.selectedDeployment?.status === "pending";

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Durable server program prototype</p>
          <h1>Deployment approvals</h1>
        </div>
        <div className="status-strip">
          <span data-state={stream.connection}>{stream.connection}</span>
          <span>{stream.sessionId ?? "no session"}</span>
          <span>{stream.resume?.status ?? (stream.resumed ? "resumed" : "fresh")}</span>
          <span>{stream.cursor ?? "no cursor"}</span>
          <span>projection v{stream.projectionVersion}</span>
        </div>
      </header>

      {stream.lastError ? <Banner tone="error" text={stream.lastError.message} /> : null}
      {stream.lastResult ? (
        <Banner
          tone={stream.lastResult.ok ? "success" : "error"}
          text={
            stream.lastResult.ok
              ? "Approval action completed on the server."
              : (stream.lastResult.error ?? "Action failed.")
          }
        />
      ) : null}

      {stream.projection ? (
        <section className="workspace">
          <DeploymentList
            filter={deploymentFilter}
            onFilter={setDeploymentFilter}
            projection={stream.projection}
            selectedId={selectedId}
            onSelect={(deploymentId) =>
              stream.send({
                type: "session.selectDeployment",
                deploymentId,
              })
            }
          />
          <DetailPanel
            projection={stream.projection}
            canApprove={selectedIsPending}
            onApprove={(deploymentId) =>
              stream.send({
                type: "action.approveDeployment",
                deploymentId,
              })
            }
          />
          <TracePanel
            projection={stream.projection}
            traces={stream.traces}
            onToggle={() => stream.send({ type: "session.toggleTracePanel" })}
          />
        </section>
      ) : (
        <section className="loading">Waiting for server projection...</section>
      )}
    </main>
  );
}

function Banner(props: { tone: "success" | "error"; text: string }) {
  return <div className={`banner ${props.tone}`}>{props.text}</div>;
}

function DeploymentList(props: {
  filter: string;
  onFilter: (value: string) => void;
  projection: ApprovalProjection;
  selectedId: string | null;
  onSelect: (deploymentId: string) => void;
}) {
  const deployments = props.projection.pendingDeployments.filter((deployment) =>
    `${deployment.service} ${deployment.version} ${deployment.environment}`
      .toLowerCase()
      .includes(props.filter.toLowerCase()),
  );

  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <h2>{props.projection.team.name} pending deploys</h2>
        <span>{props.projection.pendingDeployments.length}</span>
      </div>
      <label className="filter-control">
        <span>Local filter</span>
        <input
          onChange={(event) => props.onFilter(event.currentTarget.value)}
          placeholder="Filter deployments"
          type="search"
          value={props.filter}
        />
      </label>
      <div className="deployment-list">
        {deployments.map((deployment) => (
          <button
            className="deployment-row"
            data-selected={deployment.id === props.selectedId}
            key={deployment.id}
            onClick={() => props.onSelect(deployment.id)}
            type="button"
          >
            <strong>{deployment.service}</strong>
            <span>{deployment.version}</span>
            <small>
              {deployment.environment} by {deployment.requestedBy}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}

function DetailPanel(props: {
  projection: ApprovalProjection;
  canApprove: boolean;
  onApprove: (deploymentId: string) => void;
}) {
  const deployment = props.projection.selectedDeployment;

  return (
    <section className="panel detail-panel">
      <div className="panel-header">
        <h2>Selected deployment</h2>
      </div>
      {deployment ? (
        <>
          <div className="detail-main">
            <p className="eyebrow">{deployment.status}</p>
            <h3>{deployment.service}</h3>
            <p>
              {deployment.version} to {deployment.environment}
            </p>
          </div>
          <button
            className="primary-action"
            disabled={!props.canApprove}
            onClick={() => props.onApprove(deployment.id)}
            type="button"
          >
            Approve on server
          </button>
          <h4>Audit trail</h4>
          <ol className="audit-list">
            {deployment.auditTrail.map((entry) => (
              <li key={entry.id}>
                <span>{entry.event}</span>
                <small>
                  {entry.actorId} at {formatTime(entry.at)}
                </small>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="empty-state">Select a pending deployment.</p>
      )}
    </section>
  );
}

function TracePanel(props: {
  projection: ApprovalProjection;
  traces: TraceSnapshot[];
  onToggle: () => void;
}) {
  const traces = useMemo(() => props.traces.slice(0, 5), [props.traces]);

  return (
    <section className="panel trace-panel">
      <div className="panel-header">
        <h2>Trace</h2>
        <button className="secondary-action" onClick={props.onToggle} type="button">
          {props.projection.tracePanelOpen ? "Hide" : "Show"}
        </button>
      </div>
      {props.projection.tracePanelOpen ? (
        traces.length > 0 ? (
          <div className="trace-list">
            {traces.map((trace) => (
              <article className="trace" data-status={trace.status} key={trace.traceId}>
                <h3>{trace.label}</h3>
                <ol>
                  {trace.events.map((event, index) => (
                    <li key={`${trace.traceId}-${index}`}>
                      <strong>{event.phase}</strong>
                      <span>{event.label}</span>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">No messages yet.</p>
        )
      ) : (
        <p className="empty-state">Trace panel is session state on the server.</p>
      )}
    </section>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
