# RPC/MCP Unification — Current Structure

This diagram shows the merged state after the `space-actions` dispatcher became the only Space MCP surface and the typed `node-agent` / `space-agent-tools` servers were removed.

## High-level flow

```mermaid
flowchart TB
  subgraph Client [Client]
    Web["packages/web"]
    CLI["packages/cli"]
    Desktop["packages/desktop"]
  end

  subgraph Transport ["Transport: packages/shared"]
    Router["MessageHubRouter"]
    Hub["MessageHub"]
    WSTransport["WebSocketServerTransport"]
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

  subgraph MCPPlane ["MCP Tool Plane"]
    Proxy["AcpMcpProxyBridge"]
    SpaceActions["space-actions MCP server"]
    AgentMemory["agent-memory MCP server"]
    DbQuery["db-query MCP server"]
    Dispatch["call_action dispatcher"]
    Registry["ActionRegistry"]
    SpaceReg["registry-space.ts"]
    NodeReg["registry-node.ts"]
  end

  subgraph Persistence [Persistence]
    DB["SQLite"]
    Reactive["ReactiveDatabase + LiveQuery"]
  end

  Web -->|WebSocket| WSTransport
  CLI -->|WebSocket| WSTransport
  Desktop -->|WebSocket| WSTransport
  WSTransport --> Router
  Router --> Hub
  Hub -->|REQ / RSP / EVENT| RPC
  RPC --> App
  App --> SessionMgr
  App --> SpaceRuntime
  App --> Skills
  SpaceRuntime --> TaskAgentMgr
  TaskAgentMgr -->|builds & attaches| SpaceActions
  SessionMgr --> AgentSession
  Providers --> AgentSession
  Skills --> AgentSession
  AgentSession -->|tool calls| Proxy
  Proxy -->|Unix socket| SpaceActions
  Proxy -->|Unix socket| AgentMemory
  Proxy -->|Unix socket| DbQuery
  SpaceActions --> Dispatch
  Dispatch --> Registry
  Registry --> SpaceReg
  Registry --> NodeReg
  SpaceReg --> DB
  NodeReg --> DB
  DB --> Reactive
  Reactive -->|live updates| Web
```

## `call_action` sequence

```mermaid
sequenceDiagram
  participant Client as Web / CLI
  participant Transport as WebSocket
  participant Hub as MessageHub
  participant RPC as RPC Handlers
  participant App as DaemonApp
  participant Session as SessionManager
  participant Agent as AgentSession
  participant Proxy as AcpMcpProxyBridge
  participant Space as space-actions MCP
  participant Dispatch as dispatchAction
  participant Registry as ActionRegistry
  participant Handler as Action Handler
  participant DB as SQLite

  Client->>Transport: REQ (e.g. create session)
  Transport->>Hub: route
  Hub->>RPC: invoke
  RPC->>App: create / resume session
  App->>Session: configure agent
  Session->>Agent: start SDK query loop
  Agent->>Proxy: tools/call call_action
  Proxy->>Space: JSON-RPC over socket
  Space->>Dispatch: dispatchAction(name, params)
  Dispatch->>Registry: lookup action
  Registry-->>Dispatch: schema + handler
  Dispatch->>Dispatch: safety + autonomy gates
  Dispatch->>Handler: execute
  Handler->>DB: repository write
  Handler-->>Dispatch: result
  Dispatch->>DB: audit + telemetry
  Dispatch-->>Space: response
  Space-->>Proxy: JSON-RPC
  Proxy-->>Agent: tool result
  Agent-->>Session: turn outcome
  Session-->>App: outcome
  App-->>RPC: response
  RPC-->>Hub: RSP
  Hub-->>Transport: return
  Transport-->>Client: update
```

## Key points

- `MessageHub` is the northbound RPC/event transport for the web, CLI, and desktop clients.
- `AgentSession` runs the Claude Agent SDK query loop. It receives tool schemas from the daemon and calls them through `AcpMcpProxyBridge`.
- `AcpMcpProxyBridge` exposes the selected SDK MCP servers (`space-actions`, `agent-memory`, `db-query`, and `hyperneo-operations-*`) on a local Unix socket so the SDK can call them as external MCP servers.
- `TaskAgentManager` builds a `space-actions` server for each workflow worker. It composes a `NodeAgentToolsConfig` and a `SpaceAgentToolsConfig` so the worker has access to both node actions and the worker-allowlisted Space actions.
- The `call_action` dispatcher is the only Space MCP surface. It routes through `ActionRegistry`, which combines `registry-space.ts` and `registry-node.ts`, runs safety/autonomy/audit in one pipeline, and executes the handler.
- All state writes go through SQLite repositories; `ReactiveDatabase` and `LiveQuery` push changes back to clients.
