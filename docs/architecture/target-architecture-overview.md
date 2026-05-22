# Target Architecture Overview

**Date:** 2026-05-22
**Status:** Draft Design
**Related:**

- [Unified Message Fabric Architecture Design](./unified-message-fabric-design.md)
- [Space Runtime Decomposition Design](./space-runtime-decomposition.md)
- [Client State And Read Models Design](./client-state-and-read-models.md)
- [Shared Package Boundaries Design](./shared-package-boundaries.md)
- [Storage Unit Of Work And Outbox Design](./storage-unit-of-work-and-outbox.md)

---

## 1. Purpose

This document is the capstone map for the architecture cleanup. It does not introduce a new subsystem. It shows how the accepted target pieces fit together:

- `MessageFabric` as the canonical command, query, and event interface.
- `MessageHub` as a compatibility transport during migration.
- `StorageUnitOfWork` plus outbox/inbox as the durable write boundary.
- Space runtime decomposition as the workflow orchestration boundary.
- Client stores as read-model caches, not command owners.
- Shared package subpaths as the contract and type boundaries.
- Forge as a first-class Space domain slice.

The diagrams are target architecture diagrams. They are intentionally not a graph dump of current imports.

---

## 2. Architecture In One Sentence

NeoKai is a local-first agent runtime where every cross-boundary interaction is a typed command, query, or event on `MessageFabric`, every durable mutation commits through one SQLite-backed unit of work with outbox/inbox semantics, and every client or worker observes the system through read models and fabric events instead of direct service coupling.

---

## 3. High-Level Target Architecture

```mermaid
flowchart LR
  subgraph Clients["Clients And External Systems"]
    Web["Web Client"]
    Desktop["Desktop App"]
    CLI["CLI"]
    Services["Company Services"]
    Public["Public Integrations"]
    Workers["Workers And Other Daemons"]
  end

  subgraph Transports["Transport Adapters"]
    WS["WebSocket<br/>MessageHub compatibility"]
    InProc["In-process"]
    GRPC["Future gRPC"]
    NATS["Future NATS"]
    Kafka["Future Kafka"]
  end

  Fabric["MessageFabric<br/>commands, queries, events<br/>envelope, contracts, auth, routing"]

  subgraph Daemon["Daemon Application Boundary"]
    Contracts["Contract Registry<br/>schemas, auth policy, durability"]
    Space["Space Domain<br/>runtime, tasks, goals, schedules"]
    Forge["Forge Domain<br/>evidence, episodes, lessons, proposals"]
    Sessions["Agent Session Domain<br/>SDK sessions, messages, lifecycle"]
    Tools["MCP And Tool Runtime<br/>skills, permissions, server attachment"]
    Providers["AI Provider Boundary<br/>models, credentials, runtime config"]
    ExternalEvents["External Event Intake<br/>GitHub and future sources"]
  end

  subgraph Storage["Local Durability And Read Models"]
    UOW["StorageUnitOfWork<br/>transaction boundary"]
    DB["SQLite Repositories<br/>domain tables"]
    Jobs["Durable Job Queue"]
    Outbox["Message Outbox"]
    Inbox["Message Inbox"]
    LiveQuery["LiveQuery<br/>ephemeral deltas"]
    ReadModels["Read Model Projectors"]
  end

  BrowserState["Client Stores<br/>read-model caches"]

  Clients <--> Transports
  Transports <--> Fabric
  Fabric <--> Contracts
  Fabric <--> Space
  Fabric <--> Forge
  Fabric <--> Sessions
  Fabric <--> Tools
  Fabric <--> Providers
  Fabric <--> ExternalEvents

  Space --> UOW
  Forge --> UOW
  Sessions --> UOW
  Tools --> UOW
  ExternalEvents --> UOW
  UOW --> DB
  UOW --> Jobs
  UOW --> Outbox
  UOW --> Inbox
  Outbox --> Fabric
  DB --> LiveQuery
  Outbox --> ReadModels
  ReadModels --> DB
  Fabric --> BrowserState
  LiveQuery --> BrowserState
```

### Reading The Diagram

- `MessageFabric` is the semantic center. It owns command/query/event contracts and routes across transports.
- Domain modules own business behavior. They do not own WebSocket protocol details.
- `StorageUnitOfWork` is the write center. Durable state, jobs, command receipts, and outbox messages commit together.
- `LiveQuery` is not the event bus. It is an ephemeral subscribed-query mechanism backed by committed DB state.
- `MessageHub` remains behind the WebSocket compatibility adapter until client and daemon call sites migrate.

---

## 4. Slightly Detailed: Daemon Component Architecture

```mermaid
flowchart TB
  subgraph FabricLayer["MessageFabric Layer"]
    ContractRegistry["ContractRegistry<br/>names, schemas, subjects"]
    CommandRouter["CommandRouter"]
    QueryRouter["QueryRouter"]
    EventRouter["EventRouter"]
    AuthPolicy["AuthPolicy<br/>actor and resource checks"]
    TransportRegistry["TransportRegistry<br/>in-process, WebSocket, future brokers"]
  end

  subgraph Compatibility["Compatibility Layer"]
    MessageHubBridge["MessageHub Bridge<br/>legacy RPC and pubsub"]
    InternalBusBridge["InternalEventBus Bridge<br/>legacy daemon events"]
    ClientEventBridge["ClientEventBridge<br/>legacy client event forwarding"]
    LiveQueryCompat["LiveQuery RPC Adapter"]
  end

  subgraph Domains["Domain Modules"]
    SpaceDomain["Space Domain"]
    ForgeDomain["Forge Domain"]
    SessionDomain["Agent Session Domain"]
    ToolDomain["MCP And Skills Domain"]
    ProviderDomain["AI Provider Domain"]
    ExternalDomain["External Event Domain"]
  end

  subgraph SpaceDetail["Space Domain Internals"]
    SpaceFacade["SpaceRuntimeFacade"]
    RuntimeScheduler["RuntimeScheduler"]
    RunCoordinator["WorkflowRunCoordinator"]
    NodeSupervisor["NodeExecutionSupervisor"]
    ChannelDelivery["ChannelDeliveryService"]
    GateOrchestrator["GateOrchestrator"]
    CompletionCoordinator["CompletionCoordinator"]
    RecoverySupervisor["RuntimeRecoverySupervisor"]
  end

  subgraph StorageLayer["Storage And Projection Layer"]
    UOWRunner["StorageUnitOfWorkRunner"]
    Repos["Repositories"]
    JobQueue["JobQueue"]
    OutboxRepo["Outbox"]
    InboxRepo["Inbox"]
    CommandReceipts["CommandReceipts"]
    Projectors["ReadModelProjectors"]
    LiveQueryEngine["LiveQueryEngine"]
  end

  ContractRegistry --> CommandRouter
  ContractRegistry --> QueryRouter
  ContractRegistry --> EventRouter
  AuthPolicy --> CommandRouter
  AuthPolicy --> QueryRouter
  TransportRegistry --> CommandRouter
  TransportRegistry --> QueryRouter
  TransportRegistry --> EventRouter

  MessageHubBridge -.-> CommandRouter
  MessageHubBridge -.-> QueryRouter
  EventRouter -.-> MessageHubBridge
  EventRouter -.-> InternalBusBridge
  InternalBusBridge -.-> ClientEventBridge
  LiveQueryCompat -.-> QueryRouter

  CommandRouter --> SpaceDomain
  CommandRouter --> ForgeDomain
  CommandRouter --> SessionDomain
  CommandRouter --> ToolDomain
  QueryRouter --> SpaceDomain
  QueryRouter --> ForgeDomain
  QueryRouter --> SessionDomain
  QueryRouter --> ToolDomain
  EventRouter --> Projectors

  SpaceDomain --> SpaceFacade
  SpaceFacade --> RuntimeScheduler
  SpaceFacade --> RunCoordinator
  RunCoordinator --> NodeSupervisor
  RunCoordinator --> ChannelDelivery
  RunCoordinator --> GateOrchestrator
  RunCoordinator --> CompletionCoordinator
  RecoverySupervisor --> RunCoordinator

  SpaceDomain --> UOWRunner
  ForgeDomain --> UOWRunner
  SessionDomain --> UOWRunner
  ToolDomain --> UOWRunner
  ExternalDomain --> UOWRunner

  UOWRunner --> Repos
  UOWRunner --> JobQueue
  UOWRunner --> OutboxRepo
  UOWRunner --> InboxRepo
  UOWRunner --> CommandReceipts
  OutboxRepo --> EventRouter
  Repos --> LiveQueryEngine
  OutboxRepo --> Projectors
  Projectors --> Repos
```

### Cleanup Meaning

The target module flow is:

1. Transport adapters enter through fabric routers.
2. Fabric routers call domain modules.
3. Domain modules commit durable mutations through UoW.
4. Durable events leave through outbox and then return to fabric event routing.
5. Compatibility bridges only adapt old protocols to the target flow.

New code should not add new direct dependencies from RPC handlers to broad service internals when a fabric command/query boundary exists.

---

## 5. Slightly Detailed: Command Write Path

```mermaid
sequenceDiagram
  participant Client
  participant Transport as Transport Adapter
  participant Fabric as MessageFabric
  participant Auth as Auth And Policy
  participant Handler as Command Handler
  participant UOW as StorageUnitOfWork
  participant DB as SQLite Repositories
  participant Jobs as Job Queue
  participant Outbox as Message Outbox
  participant Dispatcher as Outbox Dispatcher
  participant Projector as Read Model Projector
  participant Store as Client Store

  Client->>Transport: command envelope
  Transport->>Fabric: normalized command
  Fabric->>Auth: authenticate and authorize contract
  Auth-->>Fabric: actor and policy result
  Fabric->>Handler: dispatch command
  Handler->>UOW: run synchronous transaction
  UOW->>DB: write domain rows
  UOW->>Jobs: enqueue accepted async work if needed
  UOW->>Outbox: append durable events
  UOW-->>Handler: commit result
  Handler-->>Fabric: completed or accepted result
  Fabric-->>Transport: command response
  Transport-->>Client: result
  UOW->>Dispatcher: wake after commit
  Dispatcher->>Fabric: publish durable events
  Fabric->>Projector: project event
  Projector->>DB: update materialized read model if needed
  Fabric->>Store: event notification
```

### Write Path Rules

- Validation and async preparation can happen before the UoW.
- The UoW transaction body stays synchronous and short.
- Domain writes, job enqueue, command receipt updates, and outbox append happen in one commit.
- Client command responses are not the durable source of truth; committed state plus events are.
- Event dispatch may retry, so event consumers must be idempotent.

---

## 6. Slightly Detailed: Query And Subscription Path

```mermaid
flowchart LR
  ClientComponent["UI Component"]
  ClientStore["Focused Client Store<br/>SpaceTaskStore, ForgeStore, RuntimeStore"]
  FabricClient["Fabric Client"]
  QueryRouter["MessageFabric QueryRouter"]
  QueryHandler["Query Handler"]
  ReadModel["Server Read Model<br/>SQL or materialized projection"]
  Repos["Repositories"]
  LiveQuery["LiveQueryEngine<br/>subscribed query adapter"]
  Reactive["ReactiveDatabase<br/>post-commit invalidation"]
  OutboxEvents["Durable Events"]
  Projectors["ReadModelProjectors"]

  ClientComponent --> ClientStore
  ClientStore --> FabricClient
  FabricClient --> QueryRouter
  QueryRouter --> QueryHandler
  QueryHandler --> ReadModel
  ReadModel --> Repos

  ClientStore --> LiveQuery
  LiveQuery --> Repos
  Repos --> Reactive
  Reactive --> LiveQuery
  LiveQuery --> ClientStore

  OutboxEvents --> Projectors
  Projectors --> ReadModel
  Projectors --> Repos
  OutboxEvents --> ClientStore
```

### Query Path Rules

- One-shot queries and live subscriptions share query contracts where practical.
- Components do not call RPC directly once a focused store owns that read model.
- LiveQuery deltas are ephemeral and recoverable by resubscription.
- Server read models may be SQL queries at first and materialized projections later.
- Durable events drive projection replay; they are not replaced by LiveQuery.

---

## 7. Slightly Detailed: Space Runtime And Agent Path

```mermaid
flowchart TB
  Fabric["MessageFabric"]
  SpaceFacade["SpaceRuntimeFacade"]
  Scheduler["RuntimeScheduler"]
  Intake["StandaloneTaskIntake"]
  Coordinator["WorkflowRunCoordinator"]
  StateMachine["WorkflowRunStateMachine"]
  Nodes["NodeExecutionSupervisor"]
  Channels["ChannelDeliveryService"]
  Gates["GateOrchestrator"]
  Completion["CompletionCoordinator"]
  Recovery["RuntimeRecoverySupervisor"]
  AgentGateway["AgentSessionGateway"]
  SessionDomain["Agent Session Domain"]
  SDK["Agent SDK Session"]
  Provider["AI Provider"]
  MCP["Runtime MCP Servers<br/>Space, node, Forge tools"]
  UOW["StorageUnitOfWork"]
  Outbox["Runtime Events Outbox"]
  Projectors["Runtime Projectors<br/>agent notifications and read models"]

  Fabric <--> SpaceFacade
  SpaceFacade --> Scheduler
  Scheduler --> Coordinator
  SpaceFacade --> Intake
  Intake --> Coordinator
  Coordinator --> StateMachine
  Coordinator --> Nodes
  Coordinator --> Channels
  Coordinator --> Gates
  Coordinator --> Completion
  Recovery --> Coordinator
  Recovery --> Nodes

  Nodes --> AgentGateway
  AgentGateway --> SessionDomain
  SessionDomain --> SDK
  SDK --> Provider
  SDK --> MCP
  MCP --> Fabric

  Coordinator --> UOW
  Nodes --> UOW
  Channels --> UOW
  Gates --> UOW
  Completion --> UOW
  UOW --> Outbox
  Outbox --> Fabric
  Outbox --> Projectors
```

### Runtime Rules

- `SpaceRuntimeFacade` is the boundary; outside modules should not coordinate workflow internals directly.
- Runtime state transitions are decided by runtime components and committed through UoW.
- Agent SDK mechanics are behind `AgentSessionGateway` and the Agent Session domain.
- MCP tools call fabric commands or runtime facade methods, not arbitrary repositories.
- Runtime events that matter for recovery or read models are durable outbox events.

---

## 8. Slightly Detailed: Package And Dependency Boundaries

```mermaid
flowchart TB
  subgraph Shared["@neokai/shared"]
    Contracts["contracts<br/>commands, queries, events"]
    DomainTypes["domain/*<br/>Space, Forge, Session, Settings"]
    ReadModelTypes["read-models/*"]
    MessagingProtocol["messaging/protocol"]
    MessagingClient["messaging/client"]
    CompatHub["compat/message-hub"]
    SDKTypes["sdk/*"]
    ProviderTypes["provider"]
    Utils["utils and logger"]
  end

  subgraph Daemon["packages/daemon"]
    DaemonDomains["domain services"]
    DaemonStorage["storage and repositories"]
    DaemonRuntime["space runtime"]
    DaemonAdapters["transport and compatibility adapters"]
  end

  subgraph Web["packages/web"]
    Stores["client stores"]
    Views["views and components"]
    WebTransport["fabric client and MessageHub compatibility"]
  end

  Contracts --> DaemonDomains
  Contracts --> Stores
  DomainTypes --> DaemonDomains
  DomainTypes --> Stores
  ReadModelTypes --> Stores
  MessagingProtocol --> DaemonAdapters
  MessagingProtocol --> WebTransport
  MessagingClient --> WebTransport
  CompatHub -.-> DaemonAdapters
  CompatHub -.-> WebTransport
  SDKTypes --> DaemonDomains
  ProviderTypes --> DaemonDomains
  Utils --> DaemonDomains
  Utils --> Stores

  DaemonDomains --> DaemonStorage
  DaemonRuntime --> DaemonDomains
  Views --> Stores
  Stores --> WebTransport
```

### Package Rules

- Shared root imports shrink over time.
- Contracts are shared between daemon and clients.
- Domain types are durable entity shapes, not service implementations.
- Read models are UI/query projections, not DB rows by default.
- MessageHub exports move under compatibility paths.
- Daemon-only services, repositories, prompts, and tool implementation details do not leak into shared root exports.

---

## 9. Migration Boundaries

```mermaid
flowchart LR
  LegacyRPC["Legacy RPC Handlers"]
  LegacyHub["MessageHub"]
  LegacyEvents["InternalEventBus"]
  DirectServices["Direct Service Calls"]
  DirectDB["Direct db.transaction calls"]

  Fabric["MessageFabric"]
  UOW["StorageUnitOfWork"]
  Outbox["Outbox Dispatcher"]
  FocusedStores["Focused Client Stores"]
  SubpathShared["Shared Subpath Exports"]

  LegacyRPC -.-> Fabric
  LegacyHub -.-> Fabric
  LegacyEvents -.-> Outbox
  DirectServices -.-> Fabric
  DirectDB -.-> UOW

  Fabric --> UOW
  UOW --> Outbox
  Fabric --> FocusedStores
  SubpathShared --> Fabric
  SubpathShared --> FocusedStores
```

### Cleanup Direction

The migration does not delete legacy surfaces first. It routes them behind the target surfaces, migrates vertical slices, and then removes unused compatibility paths.

Preferred order:

1. Add target primitives beside existing code.
2. Bridge legacy RPC/MessageHub/InternalEventBus paths into the target flow.
3. Migrate one vertical slice at a time.
4. Move clients to focused stores and fabric contracts.
5. Remove direct service and shared-root dependencies once call sites are gone.
6. Add enforcement only after replacement paths exist.

---

## 10. What This Means For The Refactor

The refactor should be organized around vertical slices, not package-wide rewrites.

The first slice should prove the full target path with a small domain:

```mermaid
flowchart LR
  Client["Client create task"]
  FabricCommand["space.task.create command"]
  UOW["UOW transaction"]
  TaskRow["space_tasks row"]
  Receipt["command_receipt"]
  EventRow["outbox: space.task.created"]
  Dispatcher["outbox dispatcher"]
  LegacyBridge["MessageHub compatibility event"]
  Store["SpaceTaskStore update"]

  Client --> FabricCommand
  FabricCommand --> UOW
  UOW --> TaskRow
  UOW --> Receipt
  UOW --> EventRow
  EventRow --> Dispatcher
  Dispatcher --> LegacyBridge
  LegacyBridge --> Store
```

That slice exercises the architecture without requiring the whole runtime to move at once.

After that, the next slices should be:

1. `space.task.update` and archive/cancel paths.
2. schedule fire path because it already needs transactional job/task/schedule behavior.
3. Forge proposal task creation and rollup application.
4. runtime run/task/node transitions.
5. client focused stores and read models.
6. shared package root export reduction and enforcement.

---

## 11. Architectural Exit Criteria

The cleanup is working when these are true:

- New cross-boundary behavior is registered as a fabric command, query, or event.
- New durable writes use `StorageUnitOfWork`.
- Durable events are appended through outbox before publication.
- Client components depend on focused stores and read models, not broad RPC helpers.
- Space runtime transitions have one owner and are recoverable from durable state.
- Forge has its own contracts, domain types, read models, and events.
- `@neokai/shared` root imports are shrinking, not growing.
- `MessageHub`, `InternalEventBus`, and direct RPC handlers are compatibility paths rather than the place new architecture is invented.
