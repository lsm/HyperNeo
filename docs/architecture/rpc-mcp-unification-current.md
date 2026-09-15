# RPC/MCP Unification — Current Structure

This diagram shows the merged state after the `space-actions` dispatcher became the consolidated Space action-dispatch surface and the typed `node-agent` / `space-agent-tools` MCP servers were removed.

## High-level flow

```mermaid
flowchart TB
  subgraph Client [Client]
    Web["packages/web"]
    Desktop["packages/desktop"]
  end

  subgraph Transport ["Transport: packages/shared"]
    WSTransport["WebSocketServerTransport"]
    Hub["MessageHub"]
    Router["MessageHubRouter"]
  end

  subgraph Daemon ["Daemon: packages/daemon"]
    RPC["RPC Handlers"]
    App["DaemonApp"]
    SessionMgr["SessionManager / SessionLifecycle"]
    AgentSession["AgentSession<br/>(SDK query loop)"]
    TaskAgentMgr["TaskAgentManager"]
    SpaceRuntime["SpaceRuntimeService"]
    Providers["Provider Registry"]
    Skills["SkillsManager"]
  end

  subgraph McpPlane ["MCP Tool Plane"]
    SdkMcp["In-process SDK MCP servers"]
    AcpBridge["AcpMcpProxyBridge<br/>(ACP-only)"]
    StdioAdapter["mcp-proxy-entry<br/>(stdio adapter)"]
    SpaceActions["space-actions MCP server"]
    AgentMemory["agent-memory MCP server"]
    DbQuery["db-query MCP server"]
    OpMcp["hyperneo-operations<br/>MCP server"]
    Dispatch["call_action dispatcher"]
    ActionReg["ActionRegistry"]
    SpaceReg["registry-space.ts"]
    NodeReg["registry-node.ts"]
    OpRegistry["OperationRegistry"]
  end

  subgraph Persistence [Persistence]
    DB["SQLite"]
    Reactive["ReactiveDatabase + LiveQuery"]
  end

  Web -->|WebSocket| WSTransport
  Desktop -->|WebSocket| WSTransport
  WSTransport -->|handleClientMessage| Hub
  Hub -->|REQ / RSP / EVENT| RPC
  Hub -.->|register / outbound| Router
  Router -->|live updates| Web
  RPC --> App
  App --> SessionMgr
  App --> SpaceRuntime
  App --> Skills
  SpaceRuntime --> TaskAgentMgr
  TaskAgentMgr -->|builds & attaches| SpaceActions
  SpaceRuntime -->|attachSpaceToolsToMemberSession| SpaceActions
  SpaceRuntime -->|attachSpaceToolsToMemberSession| AgentMemory
  SpaceRuntime -->|attachSpaceToolsToMemberSession| DbQuery
  SessionMgr --> AgentSession
  Providers --> AgentSession
  Skills --> AgentSession
  AgentSession -->|in-process tool calls| SdkMcp
  SdkMcp --> SpaceActions
  SdkMcp --> AgentMemory
  SdkMcp --> DbQuery
  SdkMcp --> OpMcp
  AgentSession -->|attaches| OpMcp
  OpMcp -->|invoke tool| OpRegistry
  RPC -->|operation.invoke| OpRegistry
  OpRegistry --> DB
  AcpBridge -->|hosts socket| SdkMcp
  StdioAdapter -->|ProxyCallRequest over Unix socket| AcpBridge
  ACP["ACP Agent<br/>(out-of-process)"] -->|stdio MCP JSON-RPC| StdioAdapter
  SpaceActions -->|runDispatchAction| Dispatch
  Dispatch --> ActionReg
  ActionReg --> SpaceReg
  ActionReg -->|worker-only| NodeReg
  SpaceReg --> DB
  NodeReg --> DB
  DB --> Reactive
  Reactive -->|live updates| Web
```

## `session.create` sequence

`session.create` returns immediately after the session is created and its runtime MCP servers are attached. It does not start an SDK query.

```mermaid
sequenceDiagram
  participant Client as Web / Desktop
  participant WST as WebSocketServerTransport
  participant Hub as MessageHub
  participant RPC as RPC Handlers
  participant App as DaemonApp
  participant Session as SessionManager
  participant Agent as AgentSession

  Client->>WST: REQ session.create
  WST->>Hub: handleClientMessage
  Hub->>RPC: invoke session.create
  RPC->>App: create / resume session
  App->>Session: configure agent
  Session->>Agent: instantiate AgentSession
  App->>SpaceRuntime: attachSpaceToolsToMemberSession
  SpaceRuntime-->>Agent: merge runtime MCP servers (space-actions, agent-memory, db-query)
  App-->>RPC: { sessionId, session }
  RPC-->>Hub: RSP
  Hub-->>WST: send response
  WST-->>Client: { sessionId, session }
```

## `call_action` / `invoke` sequence (async agent turn)

The SDK query loop starts later and runs asynchronously. Turn outcomes reach clients through `messages.bySession` and `session.updated` LiveQuery events, not through the original request response.

```mermaid
sequenceDiagram
  participant Client as Web / Desktop
  participant WST as WebSocketServerTransport
  participant Hub as MessageHub
  participant Reactive as ReactiveDatabase
  participant Agent as AgentSession
  participant SdkMcp as SDK MCP server (in-process)
  participant AcpStdio as ACP stdio adapter
  participant Bridge as AcpMcpProxyBridge
  participant Space as space-actions MCP
  participant OpMcp as hyperneo-operations MCP
  participant Dispatch as runDispatchAction
  participant ActionReg as ActionRegistry
  participant Handler as Action Handler
  participant DB as SQLite
  participant Log as emitStructuredLogEvent

  note over Client, Agent: The SDK query loop starts after session creation and runs asynchronously.
  Agent->>SdkMcp: tools/call (in-process MCP)
  alt non-ACP session
    SdkMcp->>Space: call_action
    SdkMcp->>OpMcp: invoke (optional)
  else ACP session
    Agent->>AcpStdio: tools/call (stdio MCP JSON-RPC)
    AcpStdio->>Bridge: newline-delimited ProxyCallRequest over Unix socket
    Bridge->>SdkMcp: invoke captured tool handler
  end
  Space->>Dispatch: runDispatchAction(deps, dispatchInput)
  Dispatch->>ActionReg: lookup action (role-filtered)
  ActionReg-->>Dispatch: schema + handler
  Dispatch->>Dispatch: resolveAction, applySafetyClass, resolveTargets
  Dispatch->>Dispatch: applyRoleAdmission, applyAutonomyGate
  Dispatch->>Dispatch: applyRateAndAudit (audit write before execute)
  Dispatch->>Handler: execute
  Handler->>DB: repository or direct write
  Handler-->>Dispatch: result
  Dispatch->>Dispatch: formatResult
  Dispatch->>Log: emitDispatchTelemetry (structured log, after result)
  Dispatch-->>Space: response
  Space-->>SdkMcp: tool result
  SdkMcp-->>Agent: turn outcome
  Agent->>DB: update messages / session state
  DB->>Reactive: change notification
  Reactive->>Hub: broadcast via MessageHub/Router
  Hub->>WST: send
  WST->>Client: EVENT messages.bySession / session.updated
```

## Key points

- `MessageHub` is the northbound RPC/event transport for the web and desktop clients. `packages/cli` is the HTTP/server wrapper that installs the daemon's WebSocket upgrade handlers; it does not construct a `WebSocketClientTransport` itself.
- For inbound traffic, `WebSocketServerTransport.handleClientMessage()` delivers messages to the callback installed by `MessageHub.registerTransport()`, which calls `MessageHub.handleIncomingMessage()`. `MessageHubRouter` manages client registration and outbound delivery, not the inbound request path.
- `AgentSession` runs the Claude Agent SDK query loop. For `provider !== 'acp'`, it receives tool schemas from in-process SDK MCP servers (`space-actions`, `agent-memory`, `db-query`, and `hyperneo-operations-*`) and calls them directly. `AcpMcpProxyBridge` is constructed only when `provider === 'acp'`; it hosts a Unix socket that the external `mcp-proxy-entry` stdio adapter connects to, so the ACP agent can call the same daemon-hosted MCP servers out-of-process.
- `SpaceRuntimeService.attachSpaceToolsToMemberSession()` attaches `space-actions` and, when configured, also merges `agent-memory` and a Space-scoped `db-query` server. `space-actions` is therefore the consolidated Space action-dispatch surface, not the only Space MCP surface.
- `TaskAgentManager` builds a `space-actions` server for each workflow worker. `composeRoleActionEntries()` returns only `spaceEntries` whenever the role is not `workflow_worker`; node entries are created and merged with the worker allowlist only for `workflow_worker` sessions.
- The `call_action` dispatcher is the consolidated Space action-dispatch surface. It routes through `runDispatchAction` from `dispatcher-pipeline.ts`, which looks up the action in a role-filtered `ActionRegistry` and runs resolve, safety, target resolution, role admission, autonomy, rate, and audit before executing the handler.
- `applyRateAndAudit` writes the audit entry to the `McpAuditLogRepository` before `executeAction`. Telemetry is emitted after the outcome is known via `emitDispatchTelemetry` → `emitActionDispatchedEvent` → `emitStructuredLogEvent` by default, not to SQLite.
- Some action handlers still perform direct SQLite mutations (for example `update_session_state` in `space-handlers.ts` updates `sessions` through `requireDb().prepare(...).run(...)`); most go through repositories.
- An already-wired operations plane coexists with the dispatcher: `OperationRegistry` (`lib/operations/registry.ts`; 17 operations including `message.send` and `task.*` per `shared operation-names.ts`), the `operation.invoke` RPC handler (`lib/rpc-handlers/operation-handlers.ts`), and the `hyperneo-operations-*` MCP server attached to every agent session (`agent-session.ts`, `query-options-builder.ts`). Both adapters call `invokeOperation` from `lib/operations/invoke.ts`, which resolves the operation, validates input, executes, and validates the result.
- `session.create` returns immediately after creation and tool attachment; it does not start an SDK query. A turn begins later, and its outcomes reach clients through `messages.bySession` LiveQuery events.
- All state writes go to SQLite; `ReactiveDatabase` and `LiveQuery` push changes back to clients.
