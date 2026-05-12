# Model: Durable Server Programs

This file contains the default context for the design: the thesis, intended fit, and core vocabulary. Read this before any implementation or prototype planning work.

## Thesis

Most fullstack webapps are built as a split system:

```txt
React state
+ client cache
+ API routes or RPC
+ backend services
+ workflow logic
+ background jobs
+ logs and debugging
```

That split is familiar, but it turns one product into several loosely synchronized programs. The frontend simulates server state. The backend exposes endpoints. Client caches guess what changed. Developers manually wire optimistic updates, invalidation, permissions, loading states, and error handling.

This framework explores a different shape:

```txt
browser event
-> typed message
-> server program
-> effect transaction
-> resource changes
-> recomputed projection
-> streamed UI patch
```

The browser should not primarily "call APIs" inside the same app. It should send messages into a fullstack program. The program runs typed effects, updates durable resources, and streams changes to the browser.

React stays important, but as a rendering adapter and ecosystem bridge. The framework kernel should own the fullstack runtime model: messages, actions, resources, sessions, projections, streams, and traces.

## Intended Fit

This is most interesting for webapps where the UI is a live projection of server-side workflow:

- deployment approvals
- incident consoles
- AI task control rooms
- support case workflows
- moderation queues
- admin and operations tools
- dashboards with live actions
- collaborative or multiplayer-ish productivity tools

These apps often have permissions, long-running work, shared state, audit trails, live updates, and server-owned workflows. They are a bad match for architecture where the frontend independently owns too much state and talks to the backend through loosely related endpoints.

This is less interesting for mostly static sites, marketing pages, simple content apps, or basic CRUD where existing frameworks already provide enough value.

## Core Vocabulary

### Program

A `Program` is the fullstack application unit. It receives messages, coordinates screens, sessions, resources, effects, projections, and traces.

It is not just a route handler. It is closer to the running application model.

Example responsibilities:

- declare screens and routes
- provide services and effect capabilities
- route messages to actions or session updates
- connect sessions to resource subscriptions
- produce projections for renderer adapters
- record causal traces

### Screen

A `Screen` is a user-facing entrypoint into a program. It usually corresponds to a route, but it should not be thought of as a traditional SSR page.

A screen declares what it observes and how that observed state becomes a projection.

Conceptually:

```txt
route params + session state + observed resources -> projection
```

### Message

A `Message` is something entering the server program.

Messages can come from:

- user interactions
- form submissions
- client component events
- server timers
- background jobs
- resource subscriptions
- reconnect/resume events

Messages are the default way the browser talks to the app. They are not raw HTTP endpoints from the developer's point of view.

### Action

An `Action` is a named server transaction triggered by a message.

Actions are where validation, authorization, mutation, effect execution, invalidation, and tracing meet. They should be explicit enough that the framework can answer "what changed and why?"

An action should be able to say:

- what input it accepts
- which services or capabilities it needs
- what durable resources it mutates or invalidates
- what trace events it produced
- what optimistic or pending state may be shown

### Effect

An `Effect` is an explicit operation that may interact with the outside world or require a capability.

Examples:

- database query
- permission check
- current user lookup
- time access
- queue publish
- email send
- external API call
- log or audit write

The point is not academic purity. The point is to make backend capabilities visible and testable at the UI boundary.

### Resource

A `Resource` is typed observable state.

Resources can represent:

- entities, such as a deployment or incident
- queries, such as pending approvals
- live feeds, such as incident timeline events
- long-running process state, such as an AI run

Resources replace scattered fetches as the default data model. A screen observes resources. Actions invalidate resources. The runtime owns refresh, recomputation, subscriptions, and patch delivery.

### Session

A `Session` is the per-browser-tab conversation with the program.

It may hold conversational state:

- selected row
- open panel
- draft mode
- current workflow step
- local pending action state
- UI subscription preferences

A session is live and useful, but it is not trusted as durable truth. If it dies, the important state should be reconstructable from durable resources, snapshots, event history, or client-provided cursors.

### Projection

A `Projection` is what the server program wants the user to see.

It can be a React tree, a framework-specific UI tree, a serialized patch, or another renderable model. The exact representation can change by adapter. The important idea is that durable resources and session state produce a user-facing projection.

### Stream

A `Stream` is the live transport between browser and server program.

It carries things like:

- initial projections
- UI patches
- action results
- resource invalidations
- session updates
- trace events
- reconnect cursors

The stream is a primitive, not a side feature. This project is not centered on traditional SSR where HTML is produced once and then the client takes over.

### Adapter

An `Adapter` connects the framework kernel to a host or renderer.

Examples:

- Bun host adapter
- React web adapter
- future React Flight adapter
- possible React Native adapter
- possible terminal or native UI adapter

The early project should build a React web adapter first. The design should avoid making the kernel more React-specific than necessary.

### Trace

A `Trace` is the causal record of why something happened.

After a click, a trace should be able to show:

```txt
message
-> validation
-> authorization
-> effects
-> resource writes
-> invalidations
-> recomputation
-> streamed patch
```

Traceability is not just debugging polish. It is one of the main reasons the architecture exists.
