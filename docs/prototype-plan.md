# First Prototype Plan: Deployment Approval Vertical Slice

## Summary

Build the first prototype as a small Bun + React deployment-approval app that proves the framework model in one vertical slice:

```txt
server program
-> typed browser message
-> action/effect transaction
-> resource invalidation
-> projection recompute
-> framework stream update
-> React UI
-> causal trace
```

This is not the full framework. It is a proof-of-concept that should make the design feel real while keeping the architecture small enough to reason about. The primary risk to reduce is model clarity: the code should prove that `Program`, `Resource`, `Action`, `Session`, `Projection`, `Stream`, and `Trace` compose before we invest in broad extensibility.

## Prototype Goal

The prototype should show a deployment approval console where a user can:

- open a React UI served by Bun
- connect to the server program over a framework WebSocket stream
- see pending deployments for a team
- select a deployment, with selection stored in server session state
- approve a deployment through a typed message
- run fake auth, permission, write, audit, invalidation, and projection recompute on the server
- receive a server projection update in the browser
- inspect a trace showing why the UI changed

The key proof is that the browser does not call an app-defined API endpoint, mutate a client cache, or independently own workflow state. The browser sends framework messages into the server program and renders projections returned by the runtime.

## Non-Goals

Do not build these in the first prototype:

- real persistence
- real auth
- real deployment integrations
- full reconnect/resume
- React Flight or RSC transport
- compiler transforms
- Bun plugin infrastructure
- file routing
- generic API/RPC layer
- ORM/database integration
- polished devtools
- production deployment support
- reusable component library

The prototype may use simple in-memory data and whole-projection replacement as long as the names and boundaries leave room for the future design.

## Implementation Shape

Use a single-package Bun project at the repo root. Keep the implementation split by concept, not by framework marketing layer.

Planned structure:

```txt
package.json
tsconfig.json
src/
  framework/
    action.ts
    effect.ts
    program.ts
    projection.ts
    resource.ts
    session.ts
    stream.ts
    trace.ts
    runtime.ts
    index.ts
  demo/
    approvals/
      actions.ts
      data.ts
      program.ts
      resources.ts
      screen.tsx
      services.ts
      session.ts
      types.ts
  client/
    app.tsx
    stream-client.ts
    styles.css
  server.ts
  shell.html
tests/
  runtime.test.ts
  approvals.test.ts
```

This layout is intentionally plain. Do not introduce a monorepo, package workspace, CLI, codegen, or plugin system yet.

## Runtime Module Boundaries

### `framework/program.ts`

Owns the top-level `Program` definition and runtime registration surface.

Prototype responsibility:

- collect resources, actions, screens, sessions, and services
- expose a single program instance for the Bun host
- provide enough metadata for runtime dispatch and projection recompute

### `framework/resource.ts`

Owns resource identity, loading, observation, and invalidation.

Prototype responsibility:

- represent resource keys as stable typed-ish objects
- load resource values from service-backed loaders
- track which resources a screen observes
- mark resources invalidated after actions
- re-read invalidated resources before projection update

For the first prototype, dependency tracking can be explicit. A screen declares observed resources; an action explicitly invalidates resource keys.

### `framework/action.ts`

Owns action definition and execution.

Prototype responsibility:

- define named actions
- accept typed input at the TypeScript level
- execute server transaction logic
- collect invalidations and trace events
- return success or failure result envelopes

Actions should read as workflow transactions, not endpoint handlers.

### `framework/effect.ts`

Owns the framework-facing effect abstraction.

Decision: use the `effect` library internally for the prototype action/effect executor.

Reasoning:

- Effect already gives generator-style effect programs, service context, typed errors, and runtime execution.
- This matches the existing design sketches using `yield*`.
- It avoids spending the first prototype rebuilding a weaker effect runtime.
- It lets us test whether Effect helps or constrains the project with real code.

Constraint:

- Do not expose Effect as the conceptual identity of the framework.
- Framework APIs should talk about `Action`, `Service`, `Resource`, and `Program`.
- It is acceptable if prototype internals import from `effect`.
- It is acceptable if action implementation callbacks return Effect values.
- The React/client boundary must not depend on Effect types.

If Effect creates too much ceremony in Phase 1, the pivot is to keep the public action API and replace `framework/effect.ts` with a lightweight custom context runner.

### `framework/session.ts`

Owns per-tab conversational state.

Prototype responsibility:

- create one session per WebSocket connection
- keep selected deployment and trace panel state on the server
- apply session messages separately from durable action writes
- include session state in projection

Session state is not durable truth. If the page reloads in the first prototype, session state may reset.

### `framework/projection.ts`

Owns the server-to-client view model.

Prototype responsibility:

- define a serializable projection shape
- include enough information for the React UI to render the approval console
- keep projection independent from React component instances

For the first prototype, the server should send whole projection replacements. Name them `projection:update` rather than pretending the first version has granular patches.

### `framework/stream.ts`

Owns JSON stream envelopes shared by server and client.

Prototype responsibility:

- define client-to-server and server-to-client message shapes
- validate envelope `type` and required IDs at runtime lightly
- serialize over Bun WebSocket
- keep the protocol small but concept-shaped

### `framework/trace.ts`

Owns trace IDs and event collection.

Prototype responsibility:

- start a trace for every client message
- record action, effect, write, invalidation, projection, and error events
- send trace snapshots to the browser
- expose trace data to tests

### `framework/runtime.ts`

Owns orchestration.

Prototype responsibility:

- handle stream connect
- create session
- compute initial projection
- route client messages to session updates or actions
- run actions
- refresh invalidated resources
- recompute projection
- emit projection and trace envelopes

This is the prototype kernel. Keep it small and readable.

## Stream Protocol

Use JSON envelopes. All envelopes must include a `type`. Envelopes related to a session include `sessionId`. Envelopes related to a user action include `traceId`.

### Client To Server

```ts
type ClientEnvelope = ConnectEnvelope | ClientMessageEnvelope;
```

```ts
type ConnectEnvelope = {
  type: "connect";
  route: "/teams/:teamId/deployments";
  params: { teamId: string };
  resumeCursor?: string;
};
```

```ts
type ClientMessageEnvelope = {
  type: "message";
  sessionId: string;
  message:
    | { type: "session.selectDeployment"; deploymentId: string }
    | { type: "session.toggleTracePanel" }
    | { type: "action.approveDeployment"; deploymentId: string };
};
```

### Server To Client

```ts
type ServerEnvelope =
  | ConnectedEnvelope
  | ProjectionEnvelope
  | ActionResultEnvelope
  | TraceEnvelope
  | ErrorEnvelope;
```

```ts
type ConnectedEnvelope = {
  type: "connected";
  sessionId: string;
};
```

```ts
type ProjectionEnvelope = {
  type: "projection:update";
  sessionId: string;
  projectionVersion: number;
  projection: ApprovalProjection;
};
```

```ts
type ActionResultEnvelope = {
  type: "action:result";
  sessionId: string;
  traceId: string;
  action: "approveDeployment";
  ok: boolean;
  error?: string;
};
```

```ts
type TraceEnvelope = {
  type: "trace:update";
  sessionId: string;
  trace: TraceSnapshot;
};
```

```ts
type ErrorEnvelope = {
  type: "error";
  sessionId?: string;
  traceId?: string;
  message: string;
};
```

### First-Prototype Protocol Rules

- The client sends `connect` once after WebSocket open.
- The server replies with `connected`, then `projection:update`.
- Client interactions send `message`.
- Session messages update session state and produce `projection:update`.
- Action messages run an action and produce `action:result`, `trace:update`, and `projection:update`.
- The first version may replace the whole projection every time.
- `resumeCursor` is accepted but not implemented beyond being recorded in trace/debug state.

## Deployment Demo Data Model

Use in-memory data. Keep the model small but workflow-shaped.

```ts
type Team = {
  id: string;
  name: string;
};
```

```ts
type User = {
  id: string;
  name: string;
  role: "approver" | "viewer";
  teamIds: string[];
};
```

```ts
type Deployment = {
  id: string;
  teamId: string;
  service: string;
  version: string;
  environment: "staging" | "production";
  status: "pending" | "approved" | "rejected";
  requestedBy: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
};
```

```ts
type AuditEntry = {
  id: string;
  at: string;
  actorId: string;
  event: "deployment.approval_requested" | "deployment.approved" | "deployment.approval_denied";
  deploymentId: string;
  detail: Record<string, unknown>;
};
```

Initial seed:

- one team: `team-platform`
- one approver user: `user-approver`
- one viewer user for permission-failure tests: `user-viewer`
- three pending production deployments
- one already approved deployment
- audit entries for the initial requests

## Demo Resources

Define these resources:

```ts
PendingDeployments(teamId);
Deployment(deploymentId);
AuditTrail(deploymentId);
```

First prototype behavior:

- `PendingDeployments(teamId)` returns deployments with `status: "pending"` for that team.
- `Deployment(deploymentId)` returns one deployment.
- `AuditTrail(deploymentId)` returns audit entries for that deployment.
- The approval action invalidates all three resources where relevant.

## Demo Session State

Session state:

```ts
type ApprovalSessionState = {
  selectedDeploymentId: string | null;
  tracePanelOpen: boolean;
};
```

Session messages:

```ts
type ApprovalSessionMessage =
  | { type: "session.selectDeployment"; deploymentId: string }
  | { type: "session.toggleTracePanel" };
```

Rules:

- Selecting a deployment changes only session state.
- Selecting a deployment should update the projection with selected deployment details and audit trail.
- Toggling the trace panel changes only session state.
- Approval status is never stored only in session state.

## Demo Action

Implement one real action:

```ts
approveDeployment({ deploymentId });
```

Action flow:

```txt
validate input
-> load current user
-> load deployment
-> require user role approver
-> require deployment belongs to one of user's teams
-> require deployment status pending
-> write deployment status approved
-> write audit entry deployment.approved
-> invalidate Deployment(deploymentId)
-> invalidate PendingDeployments(teamId)
-> invalidate AuditTrail(deploymentId)
-> return success
```

Error cases:

- unknown deployment
- user lacks approver role
- user is not on deployment team
- deployment is not pending

Errors should return `action:result` with `ok: false`, record trace events, and avoid durable mutation.

## Projection Shape

The projection should be serializable JSON. React renders from this model.

```ts
type ApprovalProjection = {
  route: "/teams/:teamId/deployments";
  team: { id: string; name: string };
  currentUser: { id: string; name: string; role: "approver" | "viewer" };
  pendingDeployments: DeploymentSummary[];
  selectedDeployment: DeploymentDetail | null;
  tracePanelOpen: boolean;
  traces: TraceSummary[];
};
```

```ts
type DeploymentSummary = {
  id: string;
  service: string;
  version: string;
  environment: string;
  requestedBy: string;
  requestedAt: string;
};
```

```ts
type DeploymentDetail = DeploymentSummary & {
  status: "pending" | "approved" | "rejected";
  auditTrail: AuditEntry[];
};
```

```ts
type TraceSummary = {
  traceId: string;
  label: string;
  status: "running" | "success" | "error";
  events: TraceEvent[];
};
```

## Trace Model

Trace events should be structured and small.

```ts
type TraceEvent = {
  at: string;
  phase:
    | "message"
    | "session"
    | "action"
    | "validation"
    | "auth"
    | "permission"
    | "effect"
    | "write"
    | "resource"
    | "projection"
    | "stream"
    | "error";
  label: string;
  detail?: Record<string, unknown>;
};
```

Minimum trace for successful approval:

```txt
message received
action approveDeployment started
input validated
current user loaded
permission accepted
deployment approved
audit entry written
Deployment(id) invalidated
PendingDeployments(teamId) invalidated
AuditTrail(id) invalidated
projection recomputed
projection streamed
```

Minimum trace for failed approval:

```txt
message received
action approveDeployment started
input validated
current user loaded
permission rejected or state rejected
action failed
projection streamed if needed
```

## React UI Scope

Build a compact operational UI, not a marketing page.

Required UI regions:

- connection/session status
- pending deployment list
- selected deployment detail panel
- approve button
- trace panel

Client behavior:

- hold WebSocket connection state locally
- render the latest server projection
- send framework messages for select, approve, and trace toggle
- do not keep a client cache of deployments
- do not optimistically mark deployment approved in client state

Local client state is allowed for purely local connection details, such as socket open/closed status.

## Test Plan

Use `bun test`.

### Runtime Tests

- program can compute an initial projection for `team-platform`
- session selection changes projection without mutating deployment data
- action message routes to `approveDeployment`
- action invalidates expected resource keys
- projection version increments after session update and after action success
- trace records message, action, invalidation, and projection events

### Approval Tests

- approver can approve a pending deployment
- approved deployment disappears from `PendingDeployments(team-platform)`
- audit entry is written after approval
- viewer cannot approve deployment
- approving unknown deployment fails without writes
- approving already approved deployment fails without duplicate audit entry

### Stream Tests

- `connect` returns `connected` and initial `projection:update`
- session message returns `projection:update`
- action message returns `action:result`, `trace:update`, and `projection:update`
- malformed envelope returns `error`

### Manual Browser Check

- run the Bun dev server
- open the React UI
- verify initial pending deployment list appears
- select a deployment and see server session state reflected
- approve a deployment and see it leave the pending list
- inspect trace panel and see the causal chain
- refresh page and accept that session selection resets in this prototype

## Acceptance Criteria

The prototype is complete when:

- a full Bun + React vertical slice runs locally
- no app-defined REST/RPC endpoint is needed for the approval workflow
- the browser sends framework messages over the stream
- durable workflow state lives in in-memory resources/services, not React state
- session state controls selected deployment and trace panel state
- approval action performs validation, fake auth, permission, write, audit, and invalidation
- projection updates come from the server runtime
- trace output explains a successful and failed approval
- tests cover runtime, action, projection, resource invalidation, session, and stream behavior

## Expected Learning

After this prototype, we should be able to answer:

- Do the framework concepts compose in real TypeScript?
- Does using Effect internally clarify or distort the action model?
- Does whole-projection streaming already feel meaningfully different from API/cache glue?
- Does the deployment approval workflow make the framework's value obvious?
- Which parts of the runtime are too abstract or too concrete?
- Should Phase 2 focus on better stream patches, resource graph depth, session resume, or React integration?

## Implementation Order

When actual implementation begins, build in this order:

1. Create Bun/React/TypeScript project scaffolding.
2. Define framework types and stream envelopes.
3. Implement in-memory demo services and data.
4. Implement resources and action execution.
5. Implement session state and projection computation.
6. Implement Bun WebSocket host.
7. Implement React client and stream client.
8. Add trace collection and trace UI.
9. Add `bun test` coverage.
10. Run the manual browser check.

Do not start implementation until this plan has been reviewed as the boundary for the first vertical slice.

## References

- [Design model](design/model.md)
- [Developer experience](design/developer-experience.md)
- [Runtime architecture](design/runtime.md)
- [Experiments and scope](design/experiments.md)
- [Bun fullstack dev server](https://bun.com/docs/bundler/fullstack)
- [Bun WebSockets](https://bun.com/docs/runtime/http/websockets)
- [Effect services](https://effect.website/docs/requirements-management/services/)
- [Effect generators](https://effect.website/docs/getting-started/using-generators/)
