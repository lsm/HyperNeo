# LSP Integration Research: Claude Agent SDK & Native LSP for HyperNeo

_Research date: 2026-03-24_

> **Note on sourcing**: This document combines findings from direct inspection of the
> installed SDK artifacts (`node_modules/@anthropic-ai/claude-agent-sdk/`) and general
> web research. Any claim derived from web research that could not be cross-checked
> against local artifacts is marked **(unverified)**. Claims derived solely from
> inspecting the installed SDK or HyperNeo codebase are stated without qualification.

---

## Part 1: Claude Agent SDK Code Intelligence Capabilities

### 1.1 Built-in LSP Support

The `@anthropic-ai/claude-agent-sdk` (v0.2.81, currently used by HyperNeo) does **not**
embed LSP functionality natively. The SDK orchestrates an agent loop that calls into the
Claude Code CLI binary bundled with it. LSP is an optional capability of that CLI binary
activated through its **plugin system**: a plugin declares `lspServers` in its manifest,
which causes the CLI to spawn the listed language server processes and expose an `LSP` tool
to the agent.

**Primary activation mechanism (verified from SDK binary):**
- A Claude Code plugin must be installed and must declare `lspServers` in its manifest
- The CLI reads the plugin manifest, spawns the corresponding language server processes, and
  adds the `LSP` tool to the available tool list
- Without an installed plugin, the `LSP` tool does not appear in the agent's tool list

**Known limitation (architecture-level, observed from SDK):**
The tool list is constructed at CLI startup time. LSP server initialization is asynchronous.
Whether the `LSP` tool is reliably present in SDK-spawned agent sessions — where the first
query may fire before language servers are ready — is unclear from local artifact inspection
alone. This is a known category of issue with async initialization in CLI-as-library patterns.

**What HyperNeo can do today:**
Ensure any Claude Code LSP plugins the user has installed are discoverable by the SDK's
underlying CLI (i.e., standard `~/.claude/` plugin paths are not blocked). There is no
HyperNeo-controlled configuration switch with verified effect on LSP tool availability.

### 1.2 SDK Code Intelligence Primitives

Derived from inspecting `sdk-tools.d.ts` and `sdk.d.ts` in the installed SDK:

| Capability | Available? | Notes |
|---|---|---|
| Tree-sitter / AST parsing | No | Not in SDK; no `mode` or parsing param on `Read` tool (`FileReadInput` has `file_path`, `offset`, `limit`, `pages` only) |
| Go-to-definition | Via `LSP` tool only | Requires installed plugin + language server binary |
| Find references | Via `LSP` tool only | Same requirement |
| Hover (type/docs) | Via `LSP` tool only | Same requirement |
| Inline diff primitives | No | SDK exposes `Edit` (string replace), `MultiEdit` (batch), `Write` (overwrite) — no patch/hunk API |
| Multi-file edit coordination | Compositional | Agents sequence multiple `Edit`/`MultiEdit` calls; no atomic cross-file transaction |
| Diagnostics | Via `LSP` tool | Auto-injected after `Edit` calls when LSP is active (per Claude Code documentation) |

### 1.3 Anthropic's LSP Plugin System

Based on web research **(unverified against local artifacts)**:

Anthropic distributes LSP capability as **Claude Code plugins**. Each plugin declares a set
of `lspServers` pointing to language server binaries that must be installed on the host.
Common language servers used include `typescript-language-server` (TypeScript/JS),
`pyright-langserver` or `pylsp` (Python), `rust-analyzer` (Rust), `gopls` (Go), and
`clangd` (C/C++).

The `modelcontextprotocol/servers` reference collection does not include an official LSP
or tree-sitter MCP server from Anthropic. Third-party options exist (e.g.,
`wrale/mcp-server-tree-sitter`).

### 1.4 What the LSP Tool Provides

Based on Claude Code documentation **(unverified against local artifacts)**:

The `LSP` tool supports sub-operations including:
- `goToDefinition`
- `findReferences`
- `hover` (type info + docs)
- `documentSymbol` (file structure: classes, functions)
- `getDiagnostics` (errors/warnings)
- `goToImplementation`
- Call hierarchy tracing

Navigation operations use `file:line:col` addressing. Diagnostics are reported on a
per-file basis; after an `Edit`, the language server may automatically re-diagnose the
affected file.

**Important — LSP document sync with agent edits**: LSP servers maintain their own
in-memory view of file contents via the `textDocument/didOpen`, `textDocument/didChange`,
and `textDocument/didClose` notification protocol. When an agent edits a file via the
`Edit` tool, this write bypasses the LSP layer entirely — the language server still sees the
pre-edit content. Any subsequent `mcp__lsp__diagnostics` or `mcp__lsp__hover` call will operate on
stale state until the file is synced. This is a critical integration concern addressed in
§3.3.

### 1.5 How HyperNeo Could Leverage SDK LSP Today

**What works**: If a user has Claude Code LSP plugins installed in their local environment
(`~/.claude/`), and the LSP tool becomes available to the agent, HyperNeo will pass those
tools through to the agent automatically (the SDK reads `~/.claude/` settings). No HyperNeo
code change is required.

**Limitations**:
- HyperNeo has no control over whether the user has LSP plugins installed
- In cloud/container deployments there are no local LSP binaries or plugins
- Whether the `LSP` tool reliably appears in SDK-mode agent sessions requires further
  testing with the installed SDK version

### 1.6 Gaps Requiring Custom LSP Support

- No LSP in containerized/cloud deployments
- No control over which language servers are installed in user environments
- No structured code intelligence API accessible programmatically from the HyperNeo daemon
- Agents have no code intelligence in the default HyperNeo configuration today
- LSP document sync (§3.3) must be handled explicitly if HyperNeo manages LSP servers directly
- Call hierarchy (`callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`) not
  accessible — requires a real language server; no SDK equivalent
- Workspace-wide symbol search (`workspace/symbol`) not accessible — the SDK's `Grep` tool
  is text-only and has no awareness of symbol kinds or scopes

---

## Part 2: Native LSP Integration Evaluation

### 2.1 Current HyperNeo State

From codebase exploration:
- **No LSP infrastructure** currently exists in `packages/daemon/`
- **No AST/parsing libraries** installed (`tree-sitter`, TypeScript compiler API, etc.)
- **Clean handler architecture** in `packages/daemon/src/lib/agent/` makes it
  straightforward to add LSP as a new subsystem
- Agents have workspace context (`workspacePath`) and file system access
- MCP tool infrastructure exists: `mcp-handlers.ts` manages `.mcp.json`-based server
  configs; `query-options-builder.ts` constructs `allowedTools`/`disallowedTools` for SDK
- HyperNeo's `WorktreeManager` creates per-session isolated git worktrees — each agent
  session already has a distinct `workspacePath`. This is the primary driver of LSP server
  instance topology (see §3.2)

### 2.2 Approach Evaluation

Scores are on a 1–5 scale where **5 is best** for all dimensions.

#### Approach A: Rely on Claude Code's Built-in LSP Plugin System

**Description**: Ensure user-installed Claude Code LSP plugins are discoverable by HyperNeo-
spawned agents. No HyperNeo-specific LSP code needed.

| Factor | Score (5=best) | Notes |
|---|---|---|
| Implementation complexity | 5/5 | Zero implementation; documentation only |
| Feature completeness | 2/5 | All LSP features IF user has plugins + binaries |
| Reliability | 2/5 | Depends on user environment; async init timing unclear |
| Works in cloud/containers | 1/5 | No — requires host language server binaries |
| Maintenance burden | 5/5 | Anthropic maintains the feature |

**Verdict**: Worthwhile baseline to document but not a standalone solution. Fails for any
deployment that doesn't have a pre-configured Claude Code user environment.

---

#### Approach B: MCP-Based LSP Proxy

**Description**: HyperNeo runs a local MCP server that proxies LSP protocol to standard
language server processes (`typescript-language-server`, `rust-analyzer`, `pylsp`). Agents
call `mcp__lsp__goto_definition(file, position)` (MCP tool naming convention:
`mcp__${serverName}__${toolName}`, so server `lsp` + tool `goto_definition` →
`mcp__lsp__goto_definition`).

```
Agent → MCP tool call (mcp__lsp__goto_definition) → HyperNeo MCP server
  → LSP JSON-RPC (stdio) → typescript-language-server
  ← location result ←
```

| Factor | Score (5=best) | Notes |
|---|---|---|
| Implementation complexity | 3/5 | Need LSP JSON-RPC client + MCP server glue |
| Feature completeness | 5/5 | Full LSP feature set via standard servers |
| Reliability | 4/5 | Standard language servers are battle-tested |
| Works in cloud/containers | 3/5 | Needs language servers in container image |
| Maintenance burden | 4/5 | LSP protocol is stable; server binaries maintained by community |
| Latency | ~50–200ms | One extra MCP hop; LSP itself is fast |

**Pros:**
- Works with all existing language servers without reimplementation
- Agents get well-structured tools with typed parameters
- Standard LSP semantics (no reinventing the wheel)
- Language server binaries are small and easily containerized

**Cons:**
- Need to ship language server binaries in container images or require user installation
- Each language requires a separate server binary
- LSP server startup latency (first request cold start: 1–5 seconds)
- Requires HyperNeo to send document sync notifications after every `Edit` (see §3.3)

**Verdict**: Best balance of completeness and implementation effort. Recommended primary
approach.

---

#### Approach C: Embedded Tree-sitter

**Description**: HyperNeo embeds Tree-sitter for parsing + custom symbol analysis. Provides
LSP-like primitives (go-to-definition, find references) without external servers.

```
Agent → MCP tool call → HyperNeo daemon → tree-sitter WASM → symbol result
```

| Factor | Score (5=best) | Notes |
|---|---|---|
| Implementation complexity | 2/5 | Need parser grammars + custom analysis per language |
| Feature completeness | 3/5 | Navigation OK; semantic type info absent |
| Reliability | 4/5 | No external process dependencies |
| Works in cloud/containers | 5/5 | WASM bundle, no external deps |
| Maintenance burden | 2/5 | Must maintain symbol analysis per language |
| Latency | ~5–20ms | Very fast; pure in-process |

**Pros:**
- Zero external dependencies; works in any deployment
- Very fast (in-process WASM)
- `web-tree-sitter` available for Node/Bun; grammars available for 100+ languages

**Cons:**
- Tree-sitter gives syntax structure, not semantics. No type inference, no hover types, no
  overload resolution — these require a real language server
- Must implement symbol analysis for each language grammar separately
- Find-references across files requires building and maintaining a project-wide symbol index
- Rename refactor without type awareness will miss dynamic references (e.g., string-keyed
  property access in JS/Python)

**Verdict**: Best for offline/zero-dependency scenarios; suitable as a fast fallback for
structural queries (list symbols, find all occurrences by name) when LSP is unavailable.
Not a replacement for a language server.

---

#### Approach D: Lightweight Code Graph + Heuristics

**Description**: Parse files with Tree-sitter, build an in-memory symbol index (code
graph). Agents query the graph for navigation. No full LSP protocol.

| Factor | Score (5=best) | Notes |
|---|---|---|
| Implementation complexity | 3/5 | Symbol indexer + query API; simpler than full LSP |
| Feature completeness | 2/5 | Covers 60–70% of navigation use cases; no type info |
| Reliability | 4/5 | In-process, no external dependencies |
| Works in cloud/containers | 5/5 | No external deps |
| Maintenance burden | 3/5 | Symbol index must stay in sync with edits |

**Verdict**: A simplified variant of Approach C without the LSP protocol layer. Same
structural-only limitations. Not recommended as a primary approach given Approach C already
covers the tree-sitter use case more thoroughly.

---

### 2.3 Recommended Approach: B + C Hybrid

**Primary: MCP-Based LSP Proxy (Approach B)** for semantic features (hover types, rename,
diagnostics).
**Fallback: Tree-sitter (Approach C)** for fast structural operations when LSP is
unavailable (containerized deployments, unsupported languages).

This hybrid gives agents:
- Full semantic accuracy when language servers are available
- Graceful degradation to structural analysis when they are not
- Fast in-process operations for common structural queries (list symbols, find all
  occurrences by name)

---

## Part 3: Recommended Architecture

### 3.1 Directory Structure

```
packages/daemon/src/lib/
  lsp/
    index.ts                         # Public API: LspManager
    lsp-manager.ts                   # Lifecycle: spawn/stop/reuse LSP servers per worktree
    lsp-client.ts                    # JSON-RPC LSP client (stdio transport)
    lsp-mcp-server.ts                # MCP server exposing LSP as tools
    document-sync.ts                 # Tracks open files; sends didOpen/didChange after edits
    tree-sitter/
      index.ts                       # Public API: TreeSitterIndex
      symbol-indexer.ts              # File → symbol table using tree-sitter
      languages/                     # Per-language grammar configs
        typescript.ts
        python.ts
        rust.ts
    servers/
      typescript.ts                  # typescript-language-server config
      python.ts                      # pylsp / pyright-langserver config
      rust.ts                        # rust-analyzer config
      registry.ts                    # Language → server binary mapping
  rpc-handlers/
    lsp-handlers.ts                  # RPC: lsp.hover, lsp.goto, lsp.refs, lsp.rename, lsp.diag
```

### 3.2 LSP Server Lifecycle and Worktree Topology

HyperNeo already uses `WorktreeManager` to create per-session isolated git worktrees. Each
agent session gets a distinct `workspacePath` corresponding to a checked-out worktree. LSP
server instances should map 1:1 to active worktrees:

```
Per worktree (not per session — worktrees may outlive individual sessions):
  1. Worktree activated → LspManager.getOrSpawnServer(worktreePath, language) → LspClient
  2. LspClient connects via stdio, sends LSP initialize request with rootUri = worktreePath
  3. Server is kept alive while any session referencing the worktree is active
  4. Last session for a worktree closes → idle timeout → server killed
```

**Why per-worktree, not per-session:**
- Language servers index the entire project and maintain internal caches
- Multiple sessions may operate on the same worktree (e.g., leader + worker)
- Spawning per-session wastes memory and initialization time

**Why worktree-scoped, not workspace-scoped:**
- Different worktrees check out different branches; a shared language server would
  conflate their file states
- `WorktreeManager` already provides the correct isolation boundary
- The `LspManager` key is therefore `worktreePath`, not a workspace identifier

### 3.3 Critical: LSP Document Sync After Agent Edits

This is the most important architectural consideration for native LSP integration.

When an agent calls `Edit`, `MultiEdit`, or `Write`, the file is written directly to disk
via the daemon's file manager. The LSP server does **not** observe this change — it still
holds the pre-edit content in its in-memory buffer. Subsequent calls to `mcp__lsp__diagnostics`,
`mcp__lsp__hover`, or `mcp__lsp__find_references` will operate on stale state and return incorrect
results.

**Required solution: `DocumentSyncTracker`**

HyperNeo must intercept file writes and send corresponding LSP notifications:

```
On file write (Edit / MultiEdit / Write):
  1. DocumentSyncTracker.onFileChanged(worktreePath, filePath, newContent)
  2. If file is already open in LSP: send textDocument/didChange with new content
  3. If file is not open in LSP: send textDocument/didOpen first, then didChange
  4. After agent session ends: send textDocument/didClose for all opened files
```

This means the `lsp-handlers.ts` RPC path and the file-write path must share a reference to
the same `DocumentSyncTracker` instance for the worktree. The `AgentSession` (or
`DaemonApp`) context is the right place to hold this shared reference.

**Alternative**: Use `textDocument/didSave` only (simpler, sends notification after disk
write without tracking content). Language servers typically re-diagnose on save. This works
for diagnostics but not for in-flight `hover` or `completion` requests against unsaved edits.

**Recommendation**: Implement `didSave`-on-write first (simple, covers diagnostics); add
full `didChange` tracking in a later iteration if agents need LSP responses that reflect
in-flight edits before a save.

### 3.4 MCP Tool Definitions for Agents

The LSP capabilities are exposed as tools in a HyperNeo-managed MCP server. Tool names follow
the MCP `mcp__${serverName}__${toolName}` convention (verified from CLI binary, matching the
`mcp__ide__getDiagnostics` pattern); if the server is registered as `lsp`, tools are called
`mcp__lsp__hover`, `mcp__lsp__goto_definition`, etc.

**Coordinate system**: All LSP positions use **0-indexed** line and character numbers. This
differs from most editors and file viewers (including the `Read` tool output), which display
1-indexed line numbers. An agent reading that a symbol is on "line 45" in a `Read` result
must pass `line: 44` to LSP tools. Tool descriptions and the system prompt should make this
explicit to avoid off-by-one errors.

```typescript
// packages/daemon/src/lib/lsp/lsp-mcp-server.ts

const LSP_TOOLS = [
  {
    name: 'mcp__lsp__hover',
    description: 'Get type information and documentation for the symbol at a position',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute file path' },
        line: { type: 'number', description: '0-indexed line number' },
        character: { type: 'number', description: '0-indexed character offset' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'mcp__lsp__goto_definition',
    description: 'Jump to where a function, variable, or type is defined',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'mcp__lsp__find_references',
    description: 'Find all usages of the symbol at this position across the project',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        includeDeclaration: { type: 'boolean', default: false },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'mcp__lsp__rename',
    description: 'Propose a rename of a symbol across all files in the project (returns proposed edits, does not apply them)',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        newName: { type: 'string' },
      },
      required: ['file', 'line', 'character', 'newName'],
    },
  },
  {
    name: 'mcp__lsp__diagnostics',
    description: 'Get current errors and warnings for a file (reflects last saved state)',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
      },
      required: ['file'],
    },
  },
  {
    name: 'mcp__lsp__document_symbols',
    description: 'List all symbols (functions, classes, variables) defined in a file',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
      },
      required: ['file'],
    },
  },
  {
    name: 'mcp__lsp__workspace_symbols',
    description: 'Search for symbols by name across the entire project',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or prefix to search for' },
      },
      required: ['query'],
    },
  },
];
```

**Note on `mcp__lsp__completion`**: Autocompletion is an interactive editor feature triggered on
each keypress. LLM agents already have full file content in context and do not benefit from
this — they predict tokens themselves. `mcp__lsp__completion` is intentionally omitted from the
tool list to keep the tool count lean.

### 3.5 Example Agent Interaction Flow

```
Agent working on TypeScript codebase:

1. Agent reads a file, sees `getUserById(id)` on line 45
2. Agent calls: mcp__lsp__goto_definition({ file: "src/api.ts", line: 45, character: 12 })
3. → LspManager finds existing tsserver for this worktree
4. → LspClient sends textDocument/definition request
5. → tsserver returns: { uri: "src/db/users.ts", range: { start: {line: 23} } }
6. Agent reads: src/db/users.ts:23 — sees the full implementation
7. Agent calls: mcp__lsp__find_references({ file: "src/db/users.ts", line: 23, character: 17 })
8. → Returns all 12 call sites across the project
9. Agent makes targeted edits at each call site; after each Edit, DocumentSyncTracker
   sends textDocument/didSave to keep LSP state current
10. Agent calls mcp__lsp__diagnostics to verify no type errors remain after edits
```

### 3.6 Integration Points in HyperNeo

**1. Per-session MCP registration with shared LspManager**

The MCP server is registered per-session (required by the SDK's MCP config model), but it
must delegate to a shared, per-worktree `LspManager` singleton to avoid spawning redundant
language server processes:

```typescript
// In query-options-builder.ts
if (sessionConfig.tools?.useLspTools) {
  // Register this session's MCP endpoint — the actual LSP server is shared per worktree
  mcpServers['lsp'] = {
    type: 'stdio',
    command: process.execPath,
    args: [lspMcpServerEntrypoint, '--worktree', workspacePath, '--ipc', daemonIpcSocket],
  };
  // The lsp-mcp-server process connects back to the daemon's LspManager via IPC
  // rather than spawning its own language server
}
```

**2. `LspManager` as a `DaemonApp`-level singleton**

```typescript
// In DaemonApp (packages/daemon/src/app.ts)
this.lspManager = new LspManager();
// Sessions receive a reference; LspManager.getOrSpawnServer(worktreePath, lang)
// is safe to call concurrently — it returns existing instances
```

**3. Document sync hook in file RPC handlers**

```typescript
// In file-handlers.ts, after any file write:
const session = sessionManager.getSession(sessionId);
if (session.lspDocSync) {
  await session.lspDocSync.onFileWritten(absolutePath, newContent);
}
```

**4. Language detection on workspace open**

Scan for language markers: `tsconfig.json` → TypeScript, `Cargo.toml` → Rust,
`pyproject.toml` / `setup.py` → Python. Used to pre-warm language servers before the
first LSP tool call.

**5. RPC exposure for frontend**

Add `lsp.status` RPC handler so the frontend can show which language servers are running
per worktree (useful for debugging and for showing IDE-mode indicators in the UI).

---

## Part 4: Open Questions

### Latency Budget
- Suggested targets: < 200ms for cached queries, < 3s for cold start (first request after
  server spawn)
- Should the LSP server warm up proactively when a session starts, or lazy-initialize on
  first tool call?
- Recommendation: warm up proactively for TypeScript/Python (most common in HyperNeo
  workflows); lazy for others

### Language Priority
Which languages to support in Phase 1?
- **Must have**: TypeScript/JavaScript (HyperNeo itself is TypeScript; most agent codebases
  are TypeScript)
- **Should have**: Python (AI/ML project codebases)
- **Nice to have**: Rust, Go
- **Later**: Ruby, C#, Java, etc.

### Always-On vs On-Demand
- **Always-on**: LSP tools always in system prompt, agent decides when to use them
  - Pro: agent can use LSP at any point without explicit user configuration
  - Con: increases tool count; may confuse agents working on tasks unrelated to code
    navigation
- **On-demand**: LSP tools enabled per session or room via config (`tools.useLspTools`)
  - Pro: clean separation, opt-in, doesn't bloat tool list for simple tasks
  - Con: friction for users who always want code intelligence
- **Recommendation**: On-demand per session, with a room-level default setting

### Multi-Language Projects (Polyglot)
- `LspManager` should support multiple language servers per worktree simultaneously
- Language server selection should be per-file based on extension, not per-worktree
- Tool calls route to the correct server based on the `file` parameter's extension

### State Sharing
- **Shared across sessions using the same worktree**: Yes — reduces cold start latency,
  consistent diagnostics view
- **Fresh per session**: No — wasteful, slower
- HyperNeo's existing worktree-per-session model makes this natural: each worktree gets one
  LSP server instance, shared by all sessions targeting that worktree

### Container/Cloud Deployments
- Without language server binaries, the MCP LSP proxy degrades to the tree-sitter fallback
- HyperNeo should document a Docker base image layer with common language servers
  pre-installed for cloud deployments
- **Caution**: automatically installing language server binaries at runtime (e.g., via
  package managers) introduces security risk — arbitrary code execution from package
  registries in a long-running daemon context. Any auto-install flow requires explicit user
  opt-in and should be sandboxed or performed only on first-time setup with user confirmation.

### Rename Safety
- LSP rename is syntactically complete (covers all statically-analyzable references) but
  will miss dynamic access patterns (`obj['methodName']` in JavaScript/Python)
- `mcp__lsp__rename` should return proposed edits without applying them, letting the agent review
  and apply them explicitly via `Edit`/`MultiEdit`
- Agents should be guided (via system prompt) to call `mcp__lsp__find_references` first to
  understand scope before issuing a rename

---

## Summary

Scores are 1–5 where **5 is best** in each dimension.

| | Approach A (SDK plugin LSP) | Approach B (MCP Proxy) | Approach C (Tree-sitter) | Approach D (Code Graph) |
|---|---|---|---|---|
| Complexity (5=low effort) | 5/5 | 3/5 | 2/5 | 3/5 |
| Feature completeness | 2/5 | 5/5 | 3/5 | 2/5 |
| Cloud/container ready | 1/5 | 3/5 | 5/5 | 5/5 |
| Semantic accuracy | 2/5 | 5/5 | 2/5 | 2/5 |
| Maintenance (5=low burden) | 5/5 | 4/5 | 2/5 | 3/5 |

**Recommended path:**
1. **Phase 1** (2–4 weeks): Implement MCP-based LSP proxy (Approach B) for TypeScript and
   Python. Agents get `mcp__lsp__*` tools when `tools.useLspTools` is enabled. Includes
   `DocumentSyncTracker` for `didSave` notifications after agent file writes.
2. **Phase 2** (4–8 weeks): Add Tree-sitter fallback (Approach C) for structural queries
   in deployments without language server binaries.
3. **Phase 3** (ongoing): Expand language support; add worktree-level LSP status UI in
   HyperNeo frontend; upgrade document sync from `didSave` to full `didChange` tracking.
