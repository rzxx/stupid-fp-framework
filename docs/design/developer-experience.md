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
Which state is durable and which state is conversational?
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

These are not fetch functions sprinkled into components. They are observable resources that screens can subscribe to and actions can invalidate.

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

### 4. Separate Domain State From UI State

Domain state belongs in resources and actions. UI state belongs in the UI tier.

Examples of domain state:

- deployment approval status
- incident owner
- incident severity
- AI run status
- audit entries

Examples of UI state:

- selected deployment row
- open details panel
- current filter
- active timeline tab
- expanded trace event

The goal is not to forbid client-side state. The goal is to stop accidental client ownership of important server workflow state.

Use this placement rule:

```txt
If losing it only changes presentation, it can be local UI state.
If the server projection or resume depends on it, model it as UIState.
If losing it corrupts workflow truth, permissions, sharing, audit, or durable process state,
model it as domain state through resources and actions.
```

### 5. Project Server State Into UI

The screen observes resources, combines them with UI state, and produces a projection. The React adapter renders that projection and hosts normal React components where useful.

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

The important idea is that resources are named and observable. They are part of the program model, not hidden fetch calls.

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

This is UI state. It is useful, can be checkpointed for resume, and must not become the only copy of durable workflow truth.

### Screen Projection

```tsx
const ApprovalScreen = Screen.define("approval.deployments")
  .route("/teams/:teamId/deployments", {
    params: Schema.Struct({ teamId: Schema.String }),
  })
  .patchManifest(approvalProjectionPatchManifest)
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
