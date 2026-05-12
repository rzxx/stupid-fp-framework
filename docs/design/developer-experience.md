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
What messages can enter from the browser?
Which actions handle those messages?
What effects are allowed?
Which state is durable and which state is conversational?
What projection should be streamed back?
How will we explain why the UI changed?
```

The mental shift is from "frontend calls backend" to "the app receives messages and evolves."

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

### 3. Define Messages And Actions

Name the things users and systems can do.

Examples:

- `approveDeployment`
- `requestChanges`
- `claimIncident`
- `addIncidentNote`
- `startAgentRun`
- `cancelAgentRun`

Actions should read like workflow transactions. They are not generic endpoint names.

### 4. Separate Durable State From Conversational State

Durable state belongs in resources. Conversational state belongs in the session.

Examples of durable state:

- deployment approval status
- incident owner
- incident severity
- AI run status
- audit entries

Examples of conversational session state:

- selected deployment row
- open details panel
- current filter
- active timeline tab
- expanded trace event

The goal is not to forbid client-side state. The goal is to stop accidental client ownership of important server workflow state.

### 5. Project Server State Into UI

The screen observes resources, combines them with session state, and produces a projection. The React adapter renders that projection and hosts normal React components where useful.

### 6. Inspect The Trace

When a user clicks "Approve", the developer should be able to see the causal chain:

```txt
approveDeployment message
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
const OperationsProgram = Program.define("operations")
  .services({
    auth: AuthService,
    deployments: DeploymentService,
    incidents: IncidentService,
    audit: AuditService,
    clock: Clock,
  })
  .resources({
    deployment: Resource.entity("Deployment", DeploymentId, function* (id) {
      return yield* Deployments.find(id);
    }),

    pendingDeployments: Resource.query("PendingDeployments", TeamId, function* (teamId) {
      return yield* Deployments.pendingForTeam(teamId);
    }),
  });
```

The important idea is that resources are named and observable. They are part of the program model, not hidden fetch calls.

### Action As Server Transaction

```ts
const approveDeployment = Action.define("deployment.approve")
  .input({ deploymentId: DeploymentId })
  .run(function* ({ deploymentId }) {
    const user = yield* Auth.currentUser;
    const deployment = yield* Deployments.find(deploymentId);

    yield* Permissions.require(user, "deployment:approve", deployment.teamId);
    yield* Deployments.approve(deploymentId, user.id);
    yield* Audit.write("deployment.approved", { deploymentId, userId: user.id });

    yield* Resource.invalidate(Deployment(deploymentId));
    yield* Resource.invalidate(PendingDeployments(deployment.teamId));
  });
```

This should feel closer to a workflow transaction than an API route.

### Session State

```ts
const ApprovalSession = Session.define({
  init: () => ({
    selectedDeployment: null as DeploymentId | null,
    detailsPanel: "closed" as "closed" | "open",
    tracePanel: "closed" as "closed" | "open",
  }),

  update: {
    selectDeployment: (state, deploymentId: DeploymentId) => ({
      ...state,
      selectedDeployment: deploymentId,
      detailsPanel: "open",
    }),

    toggleTracePanel: (state) => ({
      ...state,
      tracePanel: state.tracePanel === "open" ? "closed" : "open",
    }),
  },
});
```

This is conversational UI state. It is useful, but the system should not depend on it as the only copy of durable workflow truth.

### Screen Projection

```tsx
const ApprovalScreen = Screen.define("/teams/:teamId/deployments")
  .observe(({ teamId }) => ({
    pending: PendingDeployments(teamId),
  }))
  .session(ApprovalSession)
  .view(({ pending, session, send }) => (
    <DeploymentApprovalConsole
      deployments={pending}
      selectedDeployment={session.selectedDeployment}
      onSelect={(deploymentId) => send({ type: "selectDeployment", deploymentId })}
      onApprove={(deploymentId) => send(approveDeployment({ deploymentId }))}
    />
  ));
```

The React component is ordinary UI. The surrounding model is not ordinary client-side fetching and mutation.

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
