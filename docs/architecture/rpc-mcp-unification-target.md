# RPC/MCP Unification — Target Structure

Target architecture after all operations converge on a single `OperationRegistry` and a two-stage pre-invocation pipeline: shared `resolve + validate`, then transport-specific policy.

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
    CLI["packages/cli"]
    Desktop["packages/desktop"]
    AgentSDK["Agent SDK<br/>(in-process)"]
    Acp["ACP Agent<br/>(out-of-process)"]
  end

  subgraph Transport [Shared Transport]
    Hub["MessageHub"]
    Proxy["AcpMcpProxyBridge"]
  end

  subgraph Adapters [Adapters]
    Rpc["operation.invoke<br/>RPC handler"]
    Mcp["hyperneo-operations<br/>MCP server"]
  end

  subgraph SharedPre [Shared Pre-Invocation]
    Resolve["resolve operation"]
    Validate["validate input"]
  end

  subgraph RpcPolicy [RPC-Specific Policy]
    RpcAuth["session auth"]
    RpcRate["rate limit"]
  end

  subgraph McpPolicy [MCP-Specific Policy]
    McpSafety["safety class"]
    McpTargets["resolve targets"]
    McpRole["role admission"]
    McpAutonomy["autonomy gate"]
    McpAudit["audit + rate"]
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
  CLI -->|WebSocket| Hub
  Desktop -->|WebSocket| Hub
  AgentSDK -->|MCP tools| Mcp
  Acp -->|Unix socket| Proxy
  Proxy -->|MCP| Mcp
  Hub -->|REQ/RSP| Rpc
  Rpc --> SharedPre
  Mcp -->|tools/call invoke| SharedPre
  Resolve --> Validate
  Validate -->|RPC path| RpcAuth
  Validate -->|MCP path| McpSafety
  RpcAuth --> RpcRate
  RpcRate --> OpRegistry
  McpSafety --> McpTargets
  McpTargets --> McpRole
  McpRole --> McpAutonomy
  McpAutonomy --> McpAudit
  McpAudit --> OpRegistry
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

  class Web,CLI,Desktop,AgentSDK,Acp client
  class Hub,Proxy transport
  class Rpc,Mcp adapter
  class Resolve,Validate shared
  class RpcAuth,RpcRate rpcpolicy
  class McpSafety,McpTargets,McpRole,McpAutonomy,McpAudit mcppolicy
  class OpRegistry ops
  class Tasks,Messaging,Workflows,Goals,Evolve,Memory,Events,Ext subsystem
  class SpaceOrganizer,Scope,Permission space
  class DB,Reactive persist
  class Ext ext
```

## Key ideas

- **Two-stage pre-invocation**:
  - **Shared**: resolve the operation and validate input. Same for both RPC and MCP.
  - **Transport-specific policy**: after validation, the RPC adapter runs session auth and rate limits, while the MCP adapter runs the stricter agent policy — safety class, target resolution, role admission, autonomy gate, and audit.
- **Operations plane**: a flat `OperationRegistry` of subsystem operations (`tasks`, `messaging`, `workflows`, `goals`, `evolve`, `memory`, `external events`, plus extension subsystems). No `Space`/`Node` split and no separate `ActionRegistry`.
- **Space as organizer**: scopes, permissions, and roles configure which operations are allowed in a session, especially for the agent/MCP path.
- **Two thin adapters**: `operation.invoke` for MessageHub RPC and `hyperneo-operations` MCP server for the agent SDK and ACP.
- **Extensibility**: a new subsystem registers its operations in `OperationRegistry` without touching the core adapters or policy logic.
- **Persistence unchanged**: all writes still go through SQLite; `ReactiveDatabase` and `LiveQuery` push updates back to clients.
