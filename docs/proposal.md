# Proposal: Durable Server Programs for React UIs

## Summary

This project is an experimental Bun-native framework for building webapps as durable server programs with React UIs.

It is not trying to be another page framework, API framework, or React meta-framework. The core idea is that a webapp should be one functional fullstack program: the browser connects to a server-side conversation, user events become typed messages, messages run server effects, effects update durable resources, and resource changes stream UI patches back to the browser.

The framework should preserve React ecosystem support, but React should be the rendering surface rather than the architecture. The architecture should be closer to a mix of Effect-style backend logic, LiveView-style server sessions, Elm-style message discipline, and resource-driven UI updates.

The working thesis:

```txt
Build webapps as durable server programs, not client/server glue.
```

## Why This Should Exist

Modern fullstack webapps often split one product into several fake-separate systems:

- frontend state
- client cache
- API routes or RPC procedures
- backend services
- workflow state
- authorization logic
- background jobs
- optimistic UI logic
- audit/debug traces

That split creates a lot of duplicated state and unclear ownership. The UI calls endpoints, the backend mutates state, the frontend manually invalidates caches, and developers have to reconstruct why the screen changed by mentally following code across multiple layers.

This project rejects that as the default mental model.

The app should be modeled as one running fullstack program. The UI should not primarily "call APIs." It should send typed messages into the program. The program should run typed effects, update resources, and stream the resulting UI changes.

The project exists to explore whether webapps can feel more like durable functional systems than a pile of fetches, caches, endpoints, and local state.

## What Makes It Special

### No API-First Mental Model

APIs are useful integration boundaries, but they should not be the default way one part of a fullstack app talks to another part of the same app.

In this framework, UI events become messages sent into a server program. Backend logic is not hidden behind ad hoc endpoint glue. It is part of the same application model.

### No Fetch And Cache Soup

Screens should not be built from scattered fetching hooks, manual invalidation, optimistic state patches, and duplicated loading/error conventions.

Instead, screens observe typed resources. Actions mutate durable state and invalidate resources. The runtime owns recomputation, refresh, streaming, and patch delivery.

### Server-Owned Workflow State

Many serious webapps are workflow tools: admin consoles, approval queues, incident dashboards, support case systems, AI task consoles, deployment control planes, and operational UIs.

In these apps, the important state usually belongs on the server. The browser should be a live projection of a server-owned workflow, not a mostly independent client app trying to synchronize with backend reality.

### Durable Live Sessions

The framework should borrow the best part of LiveView: the UI feels like a live server-side process.

But unlike traditional long-lived process models, sessions should be designed for serverless environments from the start. A session can die, reconnect, replay or restore from durable state, and continue the conversation.

### Typed Effects At The UI Boundary

Server programs should declare the services and capabilities they need: auth, database access, time, queues, permissions, external APIs, logging, and so on.

This keeps backend effects explicit and testable while still allowing UI code to live near the workflow it represents.

### React Compatibility Without React Owning The Architecture

React has the ecosystem: Radix, React Aria, TanStack Table, Monaco, charting libraries, form libraries, and existing teams' knowledge.

The framework should support React components and client islands as first-class rendering tools. But the application model should not collapse into ordinary React state, hooks, and fetch/cache conventions.

### Causal Devtools

The first "this is different" moment should be seeing exactly why the UI changed.

After a user action, devtools should be able to show a trace like:

```txt
message
-> validation
-> authorization
-> effect transaction
-> database/resource changes
-> invalidated resources
-> recomputed projection
-> streamed UI patch
```

This is more interesting than a prettier network tab. It treats UI updates as causal consequences of fullstack transactions.

## Developer Mental Model

Developers should think less like this:

```txt
Where do I fetch this?
Which endpoint do I call?
Which client cache owns this data?
Where do I put optimistic state?
How do I manually invalidate everything?
```

And more like this:

```txt
What is the running program?
What resources does it observe?
What messages can users send?
What effects are allowed?
What state is durable and what state is conversational?
What changed, and why?
```

The core objects are not pages and endpoints. The core objects are programs, messages, effects, resources, sessions, and projections.

## Possible Syntax Direction

The syntax should stay TypeScript-first. A custom language may become interesting later, but the first goal is not different syntax for the same old architecture. The first goal is a different programming model.

Resources represent durable or observable state:

```ts
const Post = Resource.entity("Post", PostId, {
  read: Effect.fn(function* (id) {
    return yield* Posts.find(id)
  }),
})
```

Actions are typed server transactions:

```ts
const renamePost = Action.define("post.rename")
  .input({ id: PostId, title: NonEmptyString })
  .run(function* ({ id, title }) {
    const user = yield* Auth.currentUser

    yield* Permissions.require(user, "post:edit", id)
    yield* Posts.rename(id, title)
    yield* Resource.invalidate(Post(id))
  })
```

Screens observe resources and connect them to a session:

```tsx
const PostScreen = Screen.define("/posts/:id")
  .observe(({ id }) => ({
    post: Post(id),
    comments: Comments.forPost(id),
  }))
  .session(PostSession)
  .view(({ post, comments, send }) => (
    <PostEditor
      post={post}
      comments={comments}
      onRename={(title) => send(renamePost({ id: post.id, title }))}
    />
  ))
```

Sessions own live per-tab conversational state:

```ts
const PostSession = Session.define({
  init: () => ({ selectedComment: null, draftOpen: false }),

  update: {
    selectComment: (state, id) => ({ ...state, selectedComment: id }),
    openDraft: (state) => ({ ...state, draftOpen: true }),
  },
})
```

This API shape is only illustrative. The important part is the model: resources are durable truth, sessions are live conversations, actions are effectful transactions, and React is the rendering surface.

## First Canonical Demo

The first demo should be a workflow console, not a todo app.

Good candidates:

- incident manager
- order review queue
- deployment approval console
- AI task control room
- support case workflow
- moderation queue

This kind of app can prove the framework's real ideas:

- server-owned process state
- typed user actions
- permissions and authorization
- long-running jobs
- resource invalidation
- live streamed updates
- reconnect and resume
- causal traces
- React client widgets where useful

The demo should make it obvious why this model exists. A todo app would make the framework look like different syntax for normal CRUD.

## Non-Goals

This project should avoid becoming:

- a Next.js clone
- a file-router-first framework
- a traditional SSR framework
- a wrapper around existing state/query/RPC libraries
- a generic API framework
- a toy language whose main value is syntax novelty
- a framework that hides or fights the React ecosystem

The project can support APIs, file routing, SSR-like output, and normal React components where useful. They should not be the center of gravity.

## Early Architecture Direction

The current preferred direction is:

```txt
Effectful resource graph
+ resumable server sessions
+ React-compatible rendering adapter
+ Bun-native runtime
```

The framework kernel should not be React Flight itself. A custom stream should come first so the project can explore its own runtime model. React Flight or RSC compatibility can become an adapter or target later if it fits without forcing the architecture into a traditional React framework shape.

The first runtime should run on plain Bun, but the model should be designed with serverless and durable-session semantics in mind. A process may die. A session should be able to reconnect and restore from durable resource state, snapshots, or event history.

## Project Identity

This is an experimental framework and webapp-concepts lab.

It should not pretend to be production-ready early. It should also not be treated as a throwaway toy. Every part of the project should be designed seriously enough that the ideas can be tested honestly.

The intended first audience is app/tool builders who feel the pain of API-first apps and client cache soup. The second audience is framework hackers interested in RSC, LiveView, effects, serverless runtimes, and functional UI architecture.

The project should feel experimental, direct, and architecturally serious.

The simplest pitch:

```txt
A serverless functional LiveView kernel for React.
```

The sharper pitch:

```txt
Build webapps as durable server programs, not client/server glue.
```
