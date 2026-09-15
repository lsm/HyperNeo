# RPC/MCP Unification — Target Structure

Target architecture after all operations converge on a single `OperationRegistry` and a two-stage pre-invocation pipeline: transport-specific caller policy first, then shared `resolve + parse + execute + validate`.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#e1f5e1', 'primaryTextColor': '#1a1a1a', 'primaryBorderColor': '#2e7d32', 'lineColor': '#666666', 'secondaryColor': '#e3f2fd', 'tertiaryColor': '#fff3e0'}}}%%
flowchart TB
  classDef client fill:#e3f2fd,stroke:#1565c0,stroke-width:2px,color:#1a1a1a
  classDef transport fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px,color:#1a1a1a
  classDef adapter fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#1a1a1a
  classDef shared fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1a1a1a
  classDef rpcpolicy fill:#e1f5fe,stroke:#0277bd,stroke-width:2px,color:#1a1a1a
  classDef mcppolicy fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#1a1a1a
  classDef ops fill:#ffe0b2,stroke:#e65100,stroke-width:2px,color:#1a1a1a
  classDef subsystem fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#1a1a1a
  classDef space fill:#e1f5fe,stroke:#0277bd,stroke-width:2px,color:#1a1a1a
  classDef persist fill:#eceff1,stroke:#455a64,stroke-width:2px,color:#1a1a1a
  classDef ext fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px,stroke-dasharray: 5 5,color:#1a1a1a

  subgraph Client [Client / Agent]
    Web["packages/web"]
    Desktop["packages/desktop"]
    AgentSDK["Agent SDK<br/>(in-process)"]
    Acp["ACP Agent<br/>(out-of-process)"]
    AcpStdio["ACP stdio adapter"]
    Internal["daemon internal caller"]
  end

  subgraph Transport [Shared Transport]
    Hub["MessageHub"]
    Proxy["AcpMcpProxyBridge"]
  end

  subgraph Adapters [Adapters]
    Rpc["operation.invoke<br/>RPC handler"]
    Mcp["hyperneo-operations<br/>MCP server"]
  end

  subgraph RpcPolicy [RPC Pre-Invocation]
    RpcAuth["resolve human principal"]
    RpcScope["resolve target scope"]
    RpcMatch["require same Space"]
    RpcRate["rate limit"]
    RpcAudit["audit"]
  end

  subgraph McpPolicy [MCP Pre-Invocation]
    McpPrincipal["resolve agent principal"]
    McpScope["resolve target scope"]
    McpMatch["require same Space"]
    McpSafety["safety class"]
    McpRole["role admission"]
    McpAutonomy["autonomy gate"]
    McpRate["rate limit"]
    McpAudit["audit"]
  end

  subgraph SharedInvocation [Shared Invoker]
    Resolve["resolve operation"]
    Validate["validate input"]
    Execute["execute"]
    ValidateResult["validate result"]
  end

  subgraph OpsPlane [Operations Plane]
    OpRegistry["OperationRegistry"]

    subgraph Subsystems [Subsystems]
      Tasks["tasks"]
      Messaging["messaging"]
      Workflows["workflows"]
      Goals["goals"]
      Evolve["evolve"]
      Memory["memory"]
      Events["external events"]
      Ext["extension subsystem<br/>(plugin)"]
    end
  end

  subgraph Space [Space: Organizer]
    SpaceOrganizer["space organizer"]
    Scope["scopes / drawers"]
    Permission["permissions + roles"]
  end

  subgraph Persistence [Persistence]
    DB["SQLite"]
    Reactive["LiveQuery"]
  end

  Web -->|WebSocket| Hub
  Desktop -->|WebSocket| Hub
  AgentSDK -->|MCP tools| Mcp
  Acp -->|stdio MCP JSON-RPC| AcpStdio
  AcpStdio -->|ProxyCallRequest over Unix socket| Proxy
  Proxy -->|MCP| Mcp
  Hub -->|REQ/RSP| Rpc
  Rpc --> RpcAuth
  Mcp -->|tools/call invoke| McpPrincipal
  McpPrincipal --> McpScope
  McpScope --> McpMatch
  McpMatch --> McpSafety
  McpSafety --> McpRole
  McpRole --> McpAutonomy
  McpAutonomy --> McpRate
  McpRate --> McpAudit
  McpAudit --> SharedInvocation
  RpcAuth --> RpcScope
  RpcScope --> RpcMatch
  RpcMatch --> RpcRate
  RpcRate --> RpcAudit
  RpcAudit --> SharedInvocation
  Internal -->|constructs OperationCaller with source internal| SharedInvocation
  Resolve --> Validate
  Validate --> Execute
  Execute --> ValidateResult
  Execute -->|delegates| OpRegistry
  ValidateResult -->|response mapping| Rpc
  ValidateResult -->|response mapping| Mcp
  OpRegistry --> Tasks
  OpRegistry --> Messaging
  OpRegistry --> Workflows
  OpRegistry --> Goals
  OpRegistry --> Evolve
  OpRegistry --> Memory
  OpRegistry --> Events
  OpRegistry --> Ext
  SpaceOrganizer -->|configures| Scope
  Scope -->|enables| Permission
  Permission -->|informs| McpRole
  Permission -->|informs| RpcAuth
  Tasks --> DB
  Messaging --> DB
  Workflows --> DB
  Goals --> DB
  Evolve --> DB
  Memory --> DB
  Events --> DB
  Ext --> DB
  DB --> Reactive
  Reactive -->|live updates| Web

  class Web,Desktop,AgentSDK,Acp,AcpStdio,Internal client
  class Hub,Proxy transport
  class Rpc,Mcp adapter
  class Resolve,Validate,Execute,ValidateResult shared
  class RpcAuth,RpcScope,RpcMatch,RpcRate,RpcAudit rpcpolicy
  class McpPrincipal,McpScope,McpMatch,McpSafety,McpRole,McpAutonomy,McpRate,McpAudit mcppolicy
  class OpRegistry ops
  class Tasks,Messaging,Workflows,Goals,Evolve,Memory,Events,Ext subsystem
  class SpaceOrganizer,Scope,Permission space
  class DB,Reactive persist
  class Ext ext
```

## Key ideas

- **Two-stage pre-invocation**:
  - **Transport-specific caller policy first.** Each transport's pre-invocation pipeline resolves the caller principal and runs transport-specific policy before the operation is resolved. This matches the ADR 0006 trust boundary: a transport must produce a trusted `OperationCaller` before the shared invoker resolves, validates, executes, and result-validates an operation.
  - **Shared invocation** for both transports: `resolve operation` → `validate input` → `execute` → `validate result`. The `invokeOperation` pipeline already implements this sequence.
  - The pre-invocation pipelines share stages where possible (`resolve target scope`, `require same Space`, `audit`) but keep transport-specific concerns separate (`resolve human principal` for RPC, `resolve agent principal`/`safety class`/`role admission`/`autonomy` for MCP).
- **Internal caller path.** Trusted daemon/runtime code constructs an `OperationCaller` with `source: 'internal'` and enters the shared invoker directly, bypassing both transports. ADR 0006 explicitly includes `internal` as a caller source.
- **Operations plane**: a flat `OperationRegistry` of subsystem operations (`tasks`, `messaging`, `workflows`, `goals`, `evolve`, `memory`, `external events`, plus extension subsystems). No `Space`/`Node` split at this layer. The `ActionRegistry`/`call_action` relationship is left open per ADR 0006 — `call_action` may become a thin front over the MCP pre-invocation pipeline or remain a parallel policy layer — and this target does not present that decision as already made.
- **Space as organizer**: scopes, permissions, and roles configure which operations are allowed in a session, especially for the agent/MCP path. The same shared stages feed both RPC and MCP role/scope decisions.
- **Two thin adapters**: `operation.invoke` for MessageHub RPC and `hyperneo-operations` MCP server for the agent SDK and ACP. Both adapters own only transport concerns (envelope parsing, caller principal, error mapping); they do not duplicate the operation effect or validation logic.
- **Result validation is mandatory.** The shared invoker validates the operation result against its schema and maps `invalid_result` back through the adapter, so malformed output becomes a typed failure rather than an untyped transport response.
- **Auditing and scope admission are not MCP-only.** The target shows `resolve target scope`, `require same Space`, and `audit` in both the RPC and MCP pre-invocation pipelines, so RPC convergence does not create an unaudited cross-scope route.
- **Persistence unchanged**: all writes still go through SQLite; `ReactiveDatabase` and `LiveQuery` push updates back to clients.
