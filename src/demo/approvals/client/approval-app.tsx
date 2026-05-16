import { useMemo, useState } from "react";
import {
  createProjectionPatchApplier,
  useProgramStream,
  type ProgramStreamReactOptions,
} from "../../../adapters/react";
import type { ProgramStreamBootstrap, TraceSnapshot } from "../../../framework";
import { approvalProjectionPatchManifest } from "../projection-manifest";
import type { ApprovalClientInput, ApprovalProjection } from "../types";

export function ApprovalApp(props: {
  bootstrap?: ProgramStreamBootstrap<ApprovalProjection, TraceSnapshot>;
}) {
  const streamOptions = useMemo<
    ProgramStreamReactOptions<ApprovalProjection, TraceSnapshot>
  >(() => {
    return {
      route: currentApprovalPath(),
      params: {},
      storageKey: "approval-stream",
      bootstrap: props.bootstrap,
      projectionTraces: (projection) => projection.traces,
      applyPatch: createProjectionPatchApplier(approvalProjectionPatchManifest),
      router: { mode: "history" },
    };
  }, [props.bootstrap]);
  const stream = useProgramStream<ApprovalClientInput, ApprovalProjection, TraceSnapshot>(
    streamOptions,
  );
  const [deploymentFilter, setDeploymentFilter] = useState("");

  const projection = stream.projection.value;
  const selectedId = projection?.selectedDeployment?.id ?? null;
  const pendingApprovalIds = new Set(
    Object.values(stream.actions.pendingInputs).flatMap((input) =>
      input.type === "action.approveDeployment" ? [input.deploymentId] : [],
    ),
  );
  const selectedIsPending = projection?.selectedDeployment?.status === "pending";

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Durable server program prototype</p>
          <h1>Deployment approvals</h1>
        </div>
        {projection ? (
          <nav className="primary-nav" aria-label="Approval views">
            <button
              data-active={projection.page === "deployments"}
              onClick={() => stream.navigate(projection.navigation.deploymentsPath)}
              type="button"
            >
              Deployments
            </button>
            <button
              data-active={projection.page === "runs"}
              onClick={() => stream.navigate(projection.navigation.runsPath)}
              type="button"
            >
              Runs
            </button>
          </nav>
        ) : null}
        <div className="status-strip">
          <span data-state={stream.connection.status}>{stream.connection.status}</span>
          <span>{stream.view.id ?? "no view"}</span>
          <span>{stream.view.resume?.status ?? (stream.view.resumed ? "resumed" : "fresh")}</span>
          <span>{stream.view.cursor ?? "no cursor"}</span>
          <span>projection v{stream.projection.version}</span>
        </div>
      </header>

      {stream.errors.last ? <Banner tone="error" text={stream.errors.last.message} /> : null}
      {stream.actions.lastResult ? (
        <Banner
          tone={stream.actions.lastResult.ok ? "success" : "error"}
          text={
            stream.actions.lastResult.ok
              ? "Approval action completed on the server."
              : (stream.actions.lastResult.error ?? "Action failed.")
          }
        />
      ) : null}

      {projection ? (
        projection.page === "deployments" ? (
          <section className="workspace deployments-workspace">
            <DeploymentList
              projection={projection}
              deploymentFilter={deploymentFilter}
              selectedId={selectedId}
              onFilter={setDeploymentFilter}
              onSelect={(deploymentId) =>
                stream.ui.send({
                  type: "ui.deployment.select",
                  deploymentId,
                })
              }
            />
            <DetailPanel
              projection={projection}
              canApprove={selectedIsPending && !pendingApprovalIds.has(selectedId ?? "")}
              pendingApproval={selectedId ? pendingApprovalIds.has(selectedId) : false}
              onApprove={(deploymentId) =>
                stream.actions.run(
                  {
                    type: "action.approveDeployment",
                    deploymentId,
                  },
                  {
                    optimistic: optimisticApproval(deploymentId),
                    settle: "projection",
                  },
                )
              }
            />
            <TracePanel
              projection={projection}
              traces={stream.traces.visible}
              onToggle={() =>
                stream.ui.send(
                  { type: "ui.trace.toggle" },
                  {
                    optimistic: (current) => ({
                      ...current,
                      tracePanelOpen: !current.tracePanelOpen,
                    }),
                  },
                )
              }
            />
            <RunPanel compact projection={projection} />
          </section>
        ) : (
          <section className="workspace runs-workspace">
            <RunPanel projection={projection} />
            <TracePanel
              projection={projection}
              traces={stream.traces.visible}
              onToggle={() =>
                stream.ui.send(
                  { type: "ui.trace.toggle" },
                  {
                    optimistic: (current) => ({
                      ...current,
                      tracePanelOpen: !current.tracePanelOpen,
                    }),
                  },
                )
              }
            />
          </section>
        )
      ) : (
        <section className="loading">Waiting for server projection...</section>
      )}
    </main>
  );
}

function optimisticApproval(deploymentId: string) {
  return (projection: ApprovalProjection): ApprovalProjection => ({
    ...projection,
    pendingDeployments: projection.pendingDeployments.filter(
      (deployment) => deployment.id !== deploymentId,
    ),
    selectedDeployment:
      projection.selectedDeployment?.id === deploymentId
        ? {
            ...projection.selectedDeployment,
            status: "approving",
          }
        : projection.selectedDeployment,
  });
}

function currentApprovalPath(): string {
  if (typeof window === "undefined") {
    return "/teams/team-platform/deployments";
  }

  return window.location.pathname === "/"
    ? "/teams/team-platform/deployments"
    : window.location.pathname;
}

function Banner(props: { tone: "success" | "error"; text: string }) {
  return <div className={`banner ${props.tone}`}>{props.text}</div>;
}

function DeploymentList(props: {
  deploymentFilter: string;
  onFilter: (value: string) => void;
  projection: ApprovalProjection;
  selectedId: string | null;
  onSelect: (deploymentId: string) => void;
}) {
  const deployments = props.projection.pendingDeployments.filter((deployment) =>
    `${deployment.service} ${deployment.version} ${deployment.environment}`
      .toLowerCase()
      .includes(props.deploymentFilter.toLowerCase()),
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
          value={props.deploymentFilter}
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
  pendingApproval: boolean;
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
            {props.pendingApproval ? "Approval pending..." : "Approve on server"}
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

function RunPanel(props: { compact?: boolean; projection: ApprovalProjection }) {
  return (
    <section className={`panel run-panel${props.compact ? " compact" : ""}`}>
      <div className="panel-header">
        <h2>Live deployment runs</h2>
        <span>{props.projection.activeRuns.length}</span>
      </div>
      <div className="run-list">
        {props.projection.activeRuns.map((run) => (
          <article className="run-row" data-status={run.status} key={run.id}>
            <div>
              <strong>{run.label}</strong>
              <small>
                {run.status} at {formatTime(run.updatedAt)}
              </small>
            </div>
            <meter max={100} min={0} value={run.progress} />
            <span>{run.progress}%</span>
          </article>
        ))}
      </div>
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
          <p className="empty-state">No trace events yet.</p>
        )
      ) : (
        <p className="empty-state">Trace panel is checkpointed UI state.</p>
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
