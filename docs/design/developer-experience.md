# Developer Experience

This file describes how a developer should think while building with the framework. It also contains illustrative TypeScript API sketches. These sketches are not final API commitments; they are meant to make the model feel concrete enough for later prototype planning.

For vocabulary and thesis context, read [model.md](model.md) first.

## Developer Mental Model

A developer building with this framework should not start with:

```txt
Which endpoint do I call?
Where do I put this fetch?
Which client cache owns this?
How do I manually invalidate the right queries?
Where do I duplicate this workflow state?
```

They should start with:

```txt
What server program is running?
What screen is the user looking at?
What resources does that screen observe?
What inputs can enter from the browser, host, or resource system?
Which actions, UI events, resource events, or system events handle those inputs?
What effects are allowed?
Which state is program-owned and which state is renderer-owned?
What projection should be streamed back?
How will we explain why the UI changed?
```

The mental shift is from "frontend calls backend" to "the app receives typed inputs and evolves."

## Building A Workflow Feature

For a workflow feature, the development loop should look roughly like this.

### 1. Name The Program Boundary

First decide what running program owns the workflow.

For example:

```txt
OperationsProgram
```

This program might contain deployment approvals, incident handoffs, and AI task monitoring. It owns the relevant actions, resources, services, and screens.

### 2. Define Durable Resources

Identify the durable truth.

Examples:

- `Deployment(id)`
- `PendingDeployments(teamId)`
- `Incident(id)`
- `IncidentTimeline(id)`
- `AgentRun(id)`

These are not fetch functions sprinkled into components. They are observable resources that screens
can subscribe to and actions can invalidate.

Also decide the resource cache scope. A resource that returns the same value for every reader can be
`global`. A resource whose value depends on tenant/team fanout should be `fanout` scoped. A resource
whose value depends on current user permissions should be `principal` scoped or `custom` scoped.

The important rule:

```txt
If two readers can receive different values for the same base resource key, the resource needs a
cache scope beyond type + id.
```

Invalidation should remain broad by default. An action invalidating `PendingDeployments(teamId)`
should refresh every observed scoped variant of that base key unless a later exact-scope API is
explicitly chosen.

### 3. Define Program Inputs

Name the things users and systems can do.

Examples:

- `deployment.approve` as an action
- `deployment.select` as a UI event
- `incident.claim` as an action
- `trace.toggle` as a UI event
- `agent.runProgressed` as a resource event
- `system.resume` as a system event

Actions should read like workflow transactions. UI events should read like view/editing changes.
Resource and system events should read like runtime inputs, not user workflow commands.

### 4. Place State By Ownership

Do not start by asking "server state or client state?" Start by asking whether the program must
observe the value.

Program-owned state is visible to the server program. It can affect projection, resume,
authorization, sharing, collaboration, traces, or resource reads.

Renderer-owned state is outside the program. It can use React state or third-party widget state, but
it must be disposable.

Examples of program-owned domain state:

- deployment approval status
- incident owner
- incident severity
- AI run status
- audit entries

Examples of program-owned `UIState`:

- selected deployment row
- open details panel
- filter text that changes server reads, resume, URL/shareability, or trace policy
- active timeline tab
- expanded trace event

Examples of renderer-owned state:

- focus bookkeeping
- element measurement
- hover state
- pointer drag position
- animation phase
- uncontrolled input composition before commit
- third-party widget internals

Protocol state is separate from both. Optimistic overlays, pending client input IDs, cursors, action
lifecycle status, and reconnect state are adapter/runtime machinery. They are not app truth.

The goal is not to forbid React implementation mechanics. The goal is to stop accidental renderer
ownership of program behavior.

Use this placement rule:

```txt
If the program must observe it, make it program-owned.
If losing it corrupts workflow truth, make it a domain resource/action.
If it is server-observed view/editing context, make it UIState.
If the program must never observe it and losing it is safe, keep it renderer-owned.
```

### 5. Project Server State Into UI

The screen observes resources, combines them with UI state, and produces a projection. The React
adapter renders that projection and hosts normal React components where useful.

Optimistic UI is expressed as protocol state: a temporary projection overlay tied to a typed input,
not as a separate state store. UI events can optimistically update server-observed view/editing
state. Actions can optimistically update the projection while their traces explain acceptance,
rejection, or rollback.

```ts
stream.ui.send(
  { type: "ui.trace.toggle" },
  {
    optimistic: (projection) => ({
      ...projection,
      tracePanelOpen: !projection.tracePanelOpen,
    }),
  },
);

stream.actions.run(
  { type: "action.approveDeployment", deploymentId },
  {
    optimistic: (projection) => markDeploymentApproving(projection, deploymentId),
    settle: "projection",
  },
);
```

`stream.ui.send` is for UI events that do not produce action results. `stream.actions.run` tracks a
pending input by client input ID and clears or rolls back the optimistic overlay when the server
responds. Low-level `stream.send` remains for adapter escape hatches, but canonical app code should
prefer the explicit UI/action split.

### 6. Inspect The Trace

When a user clicks "Approve", the developer should be able to see the causal chain:

```txt
deployment.approve action
-> input validation
-> current user lookup
-> permission check
-> deployment status write
-> audit entry write
-> Deployment(id) invalidated
-> PendingDeployments(teamId) invalidated
-> approval screen projection patched
```

That trace is part of the framework's core value, not a later debugging add-on.

## Illustrative API Sketches

These sketches show the intended shape. They are not final API commitments.

### Program And Resources

```ts
const Deployment = Resource.define("Deployment")
  .value<DeploymentRecord | undefined>()
  .key(Schema.Struct({ deploymentId: Schema.String }), {
    id: (params) => params.deploymentId,
  })
  .load((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.find(params.deploymentId);
    }),
  );

const PendingDeployments = Resource.define("PendingDeployments")
  .value<DeploymentRecord[]>()
  .key(Schema.Struct({ teamId: Schema.String }), {
    id: (params) => params.teamId,
  })
  .load((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pendingForTeam(params.teamId);
    }),
  );
```

The important idea is that resources are named and observable. They are part of the program model,
not hidden fetch calls.

Resource scope is part of the target resource contract. Illustrative shape:

```ts
const PendingDeployments = Resource.define("PendingDeployments")
  .value<DeploymentRecord[]>()
  .scope("principal")
  .key(Schema.Struct({ teamId: Schema.String }), {
    id: (params) => params.teamId,
  })
  .load((params) =>
    Effect.gen(function* () {
      const deployments = yield* Deployments;
      return deployments.pendingVisibleToCurrentUser(params.teamId);
    }),
  );
```

The scope means `PendingDeployments(teamId)` has a base identity, but its cached value is separated
by current principal. Invalidating the base key should refresh all observed principal-scoped
variants.

### Action As Server Transaction

```ts
const approveDeployment = Action.define("deployment.approve")
  .input({ deploymentId: DeploymentId })
  .run((input, context) =>
    Effect.gen(function* () {
      const user = yield* Auth.currentUser;
      const deployment = yield* Deployments.find(input.deploymentId);

      yield* Permissions.require(user, "deployment:approve", deployment.teamId);
      yield* Deployments.approve(input.deploymentId, user.id);
      yield* Audit.write("deployment.approved", {
        deploymentId: input.deploymentId,
        userId: user.id,
      });

      context.invalidate(Deployment.key({ deploymentId: input.deploymentId }));
      context.invalidate(PendingDeployments.key({ teamId: deployment.teamId }));
    }),
  );
```

This should feel closer to a workflow transaction than an API route.

### UI State

```ts
const ApprovalUI = UIState.define("approval.ui")
  .init(() => ({
    selectedDeployment: null as DeploymentId | null,
    detailsPanel: "closed" as "closed" | "open",
    tracePanel: "closed" as "closed" | "open",
  }))
  .event("deployment.select", SelectDeployment, (state, event) => ({
    ...state,
    selectedDeployment: event.deploymentId,
    detailsPanel: "open",
  }))
  .event("trace.toggle", ToggleTracePanel, (state) => ({
    ...state,
    tracePanel: state.tracePanel === "open" ? "closed" : "open",
  }))
  .build();
```

This is program-owned view state. It is useful, can be checkpointed for resume, and must not become
the only copy of durable workflow truth.

### Screen Projection

```tsx
const ApprovalScreen = Screen.define("approval.deployments")
  .route("/teams/:teamId/deployments", {
    params: Schema.Struct({ teamId: Schema.String }),
  })
  .regions({
    pendingDeployments: Region.replace(),
  })
  .project((view, context) =>
    Effect.gen(function* () {
      return {
        pending: yield* context.region("pendingDeployments", () =>
          context.resources.read(PendingDeployments.key({ teamId: view.params.teamId })),
        ),
        selectedDeploymentId: view.ui.selectedDeployment,
      };
    }),
  );
```

The React component is ordinary UI. The surrounding model is not ordinary client-side fetching and mutation.

### Program Composition

```ts
const OperationsProgram = Program.define("operations")
  .layer(OperationsLayer)
  .resources(Deployment, PendingDeployments)
  .ui(ApprovalUI)
  .screens(ApprovalScreen, DeploymentRunsScreen)
  .actions(approveDeployment, startAgentRun)
  .build();
```

Programs compose named declarations. Object literals remain useful for low-level adapter options,
but core framework concepts should read like declarations.

### Long-Running Work

```ts
const startAgentRun = Action.define("agent.startRun")
  .input({ taskId: TaskId })
  .run(function* ({ taskId }) {
    const user = yield* Auth.currentUser;

    yield* Permissions.require(user, "agent:start", taskId);
    const runId = yield* AgentRuns.start(taskId, user.id);

    yield* Resource.invalidate(AgentRun(runId));
    yield* Stream.follow(AgentRun(runId));

    return { runId };
  });
```

For an AI task control room, the action starts durable work and the stream follows its progress. The browser should not have to poll a custom endpoint and stitch together a separate client state machine.
