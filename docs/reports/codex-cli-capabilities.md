# OpenAI Codex CLI: Capabilities Research Report

**Date:** 2026-03-14
**Purpose:** Evaluate Codex CLI as a potential integration target for HyperNeo

---

## Table of Contents

1. [Overview](#overview)
2. [Technical Foundation](#technical-foundation)
3. [CLI Commands](#cli-commands)
4. [Global Flags](#global-flags)
5. [IPC and Communication Mechanisms](#ipc-and-communication-mechanisms)
   - [codex exec --json (JSONL Event Stream)](#1-codex-exec---json-jsonl-event-stream)
   - [codex app-server (JSON-RPC Daemon)](#2-codex-app-server-json-rpc-daemon)
   - [codex mcp-server (MCP Exposure)](#3-codex-mcp-server-mcp-exposure)
6. [Authentication](#authentication)
7. [Tool Execution and Sandboxing](#tool-execution-and-sandboxing)
8. [Streaming](#streaming)
9. [Multimodal Support](#multimodal-support)
10. [Concurrency and Runtime](#concurrency-and-runtime)
11. [Critical Integration Constraints](#critical-integration-constraints)
12. [Integration Modes for HyperNeo](#integration-modes-for-hyperneo)
13. [Summary Table](#summary-table)

---

## Overview

Codex CLI is OpenAI's autonomous coding agent for the terminal. It operates as a fully self-contained agent that can read files, execute shell commands, apply patches, and perform web searches — all without requiring the calling application to orchestrate these steps. It is designed for both interactive developer use (via a TUI) and programmatic automation (via headless execution and a long-lived daemon).

- **Repository:** https://github.com/openai/codex
- **License:** Apache-2.0
- **Latest version:** rust-v0.106.0+

---

## Technical Foundation

Codex CLI is written primarily in **Rust (95.2%)**, structured as the `codex-rs` Cargo workspace containing 65+ crates. This gives it:

- Low-level process control for sandboxed tool execution
- A Tokio-based multi-threaded async runtime
- A lean binary suitable for cross-platform distribution

The remaining surface (JavaScript/TypeScript) covers tooling, configuration schemas, and test harnesses.

---

## CLI Commands

| Command | Description |
|---|---|
| `codex` | Launch interactive TUI session |
| `codex exec` (alias: `codex e`) | Non-interactive headless execution — runs a task to completion and exits |
| `codex app-server` | Start a long-running JSON-RPC 2.0 daemon over stdio (or WebSocket) |
| `codex mcp-server` | Expose Codex itself as an MCP (Model Context Protocol) tool server |
| `codex resume` | Resume a previously saved session/thread |
| `codex fork` | Fork an existing thread into a new branch |
| `codex login` | Authenticate via OAuth browser flow |
| `codex logout` | Remove stored credentials |

---

## Global Flags

These flags apply across commands:

| Flag | Description |
|---|---|
| `--model, -m <model>` | Override the model (e.g., `gpt-5.4`) |
| `--sandbox, -s <level>` | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` |
| `--ask-for-approval, -a <policy>` | Approval policy: `untrusted`, `on-request`, `never` |
| `--full-auto` | Shorthand for `workspace-write` sandbox + `on-request` approvals |
| `--yolo` | Bypass all approval gates — all tool calls execute without confirmation |
| `--image, -i <path>` | Attach an image file to the prompt (PNG/JPEG) |
| `--profile, -p <name>` | Select a named configuration profile |

### `codex exec`-Specific Flags

| Flag | Description |
|---|---|
| `--json` | Emit a JSONL event stream to stdout instead of rendering a TUI |
| `-o, --output-last-message <path>` | Write the final agent message to a file |
| `--output-schema <path>` | Constrain final output to a structured JSON schema |
| `--ephemeral` | Do not persist the session to disk |
| `--skip-git-repo-check` | Skip the check that requires running inside a git repository |

---

## IPC and Communication Mechanisms

There are three distinct ways for an external application to communicate with Codex CLI.

### 1. `codex exec --json` (JSONL Event Stream)

**Mode:** Per-invocation, spawn-and-wait.

Codex is spawned as a child process with a prompt. It runs the task autonomously to completion and emits a newline-delimited JSON event stream on stdout. The parent process reads these events to observe progress and results.

**Event types:**

```json
{"type": "thread.started", "thread_id": "0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type": "turn.started"}
{"type": "item.started", "item": {"id": "item_1", "type": "command_execution", ...}}
{"type": "item.completed", "item": {"id": "item_3", "type": "agent_message", ...}}
{"type": "turn.completed", "usage": {"input_tokens": 24763, "output_tokens": 122}}
```

**Item types emitted in the stream:**

| Item Type | Description |
|---|---|
| `agent_message` | Text response from the model |
| `reasoning` | Internal reasoning steps (if exposed) |
| `command_execution` | A shell command Codex executed |
| `file_change` | A file write or patch Codex applied |
| `mcp_tool_call` | A call to an MCP tool |
| `web_search` | A web search Codex performed |
| `plan_update` | An update to the agent's internal plan |

**Use case:** Fire-and-forget automation, CI pipelines, simple query/response flows.

---

### 2. `codex app-server` (JSON-RPC Daemon)

**Mode:** Long-lived process, bidirectional protocol.

`codex app-server` starts a persistent daemon that communicates over stdio using a **JSON-RPC 2.0-lite** protocol (the `"jsonrpc":"2.0"` header field is omitted). It also supports WebSocket transport:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

**Initialization handshake:**

The client must send an `initialize` request and await a response, then send an `initialized` notification before sending any other requests.

**Thread management methods:**

| Method | Description |
|---|---|
| `thread/start` | Create a new thread and start the first turn |
| `thread/resume` | Resume a persisted thread |
| `thread/fork` | Branch an existing thread |
| `thread/list` | List all available threads |

**Turn control methods:**

| Method | Description |
|---|---|
| `turn/start` | Start a new turn in an existing thread |
| `turn/steer` | Inject a mid-turn message to redirect the agent |
| `turn/interrupt` | Abort the current turn |

**Discovery methods:**

| Method | Description |
|---|---|
| `model/list` | Enumerate available models |
| `skills/list` | Enumerate available agent skills |
| `experimentalFeature/list` | List experimental feature flags |

**Server-to-client notifications (async events):**

| Notification | Description |
|---|---|
| `turn/started` | A turn has begun |
| `turn/completed` | A turn has finished, with usage stats |
| `item/started` | An item (tool call, message, etc.) has started |
| `item/completed` | An item has completed |
| `item/agentMessage/delta` | Incremental text chunk for streaming agent messages |

**Use case:** Long-running sessions, multi-turn conversations, streaming UIs that need incremental text output.

---

### 3. `codex mcp-server` (MCP Exposure)

**Mode:** Codex exposes itself as an MCP (Model Context Protocol) tool server.

Rather than HyperNeo calling Codex as a subprocess, `codex mcp-server` allows HyperNeo's own agents (running Claude or another model) to call Codex as a **tool** through the standard MCP protocol. Codex is invoked as a named tool with a prompt, executes autonomously, and returns a result.

**Use case:** Embedding Codex as a callable sub-agent within HyperNeo's existing MCP tool ecosystem. HyperNeo's agent orchestration layer issues MCP tool calls; Codex handles the implementation work.

---

## Authentication

Codex CLI supports multiple authentication methods, suited for different deployment contexts:

| Method | Description |
|---|---|
| `OPENAI_API_KEY` env var | Recommended for CI and automation |
| `CODEX_API_KEY` env var | Alternative env var |
| `codex login` (OAuth) | Browser-based OAuth flow for interactive developer use |
| Device code auth | Headless OAuth flow for environments without a browser |
| Stored credentials | `~/.codex/auth.json` or OS keyring (populated by `codex login`) |

For programmatic integration (e.g., HyperNeo spawning Codex), `OPENAI_API_KEY` is the most straightforward path.

---

## Tool Execution and Sandboxing

Codex CLI includes a built-in `ToolRouter` that routes tool calls through configurable sandboxing and approval policies before executing them.

**Built-in tools:**

- Shell command execution (bash/zsh subprocesses)
- File patching (unified diff application)
- Web search
- JavaScript REPL

**MCP tools:** Codex can connect to external MCP servers (via stdio child processes or HTTP endpoints) and invoke their tools as part of its autonomous execution.

**Sandbox levels** (set via `--sandbox`):

| Level | Description |
|---|---|
| `read-only` | Agent may only read the filesystem; no writes or shell execution |
| `workspace-write` | Agent may read and write within the workspace directory |
| `danger-full-access` | Agent has unrestricted access to the filesystem and shell |

**Approval policies** (set via `--ask-for-approval`):

| Policy | Description |
|---|---|
| `untrusted` | All tool calls require explicit approval before execution |
| `on-request` | Approval gates are applied based on per-tool trust classification |
| `never` | No approval required; all tool calls execute immediately |

**Key point:** All tool execution happens **inside Codex**. The ToolRouter is internal to the Codex process. External callers observe tool calls as events in the event stream after they have already been executed or approved — they cannot intercept, replace, or handle tool calls themselves.

---

## Streaming

Codex CLI supports incremental output streaming through two mechanisms:

**`codex exec --json`:** JSONL events are emitted to stdout as they occur. The calling process receives `item.started` / `item.completed` events in real time, and agent message text appears in `item.completed` events once the full message is ready.

**`codex app-server`:** The `item/agentMessage/delta` notification delivers incremental text chunks as the model generates them, enabling true streaming text rendering in a UI.

For HyperNeo's chat interface, the App Server's delta notifications are the appropriate mechanism if streaming text output is desired.

---

## Multimodal Support

Codex CLI supports image inputs via the `--image, -i <path>` flag. Supported formats include PNG and JPEG. Multiple images can be attached by providing the flag multiple times.

This multimodal capability is available in both interactive TUI mode and headless `codex exec` mode.

---

## Concurrency and Runtime

The App Server is built on Tokio's multi-threaded async runtime:

- Multiple threads can run concurrently within a single App Server process
- Each thread maintains its own event store (capped at 32,768 events)
- Internal coordination uses channel-based message passing
- WebSocket transport uses bounded queues to apply backpressure and prevent memory exhaustion under load

This means a single `codex app-server` instance can serve multiple concurrent HyperNeo sessions, each mapped to a separate thread.

---

## Critical Integration Constraints

**Codex CLI is an autonomous agent, not a transparent API passthrough.**

This distinction is architecturally fundamental and has direct consequences for how HyperNeo can use Codex.

### What "autonomous agent" means in practice

When HyperNeo sends a prompt to Codex (via any integration mode), Codex takes full ownership of the execution loop:

1. It calls the model to generate a plan or response.
2. It decides which tools to invoke (shell, file patch, web search, etc.).
3. It executes those tools internally via its `ToolRouter`.
4. It iterates — calling the model again with tool results — until it deems the task complete.
5. It returns the final result or emits the final events.

HyperNeo observes this process through events or notifications. It **cannot**:

- Intercept a tool call before Codex executes it (except via interactive approval prompts in TUI mode, which are not available programmatically).
- Replace or override Codex's tool execution with HyperNeo's own implementations.
- Inject custom tools that Codex will call (unless they are exposed as MCP servers that Codex is configured to use).
- Receive raw model API responses with tool call payloads to handle client-side.

### Contrast with HyperNeo's current architecture

HyperNeo's existing agent layer (via the Claude Agent SDK) operates with full visibility and control:

- HyperNeo's daemon receives tool call requests from the model.
- HyperNeo decides whether to execute them, how to execute them, and with what sandboxing.
- HyperNeo can inject custom logic at every step of the execution loop.

Codex CLI replaces this entire loop with its own opaque implementation. The integration surface is limited to: sending a prompt and receiving events/results.

### Approval policies do not restore tool interception

The `--ask-for-approval` / `-a` flag adds human-in-the-loop approval gates, but these gates are interactive prompts within Codex's own TUI. When running headlessly (via `codex exec --json` or `codex app-server`), approval-gated tool calls will block waiting for user input on Codex's stdin/tty — they are not exposed as RPC calls that HyperNeo can respond to programmatically.

For unattended automation, `--ask-for-approval never` (or `--yolo`) must be used, meaning all tools execute without any external oversight.

### Implications for trust and observability

- HyperNeo cannot enforce its own permission model on Codex tool calls.
- HyperNeo can only observe what Codex did (via event stream), not gate what it will do.
- The sandbox level (`--sandbox`) is the only externally controllable safety boundary.
- Session isolation (workspace sandboxing, git worktrees) must be configured at process spawn time, not dynamically adjusted per tool call.

---

## Integration Modes for HyperNeo

Given the autonomous-agent constraint, three viable integration modes exist:

### Mode 1: `codex exec --json` — Spawn-per-Task

HyperNeo spawns a `codex exec --json` child process for each task, reads the JSONL event stream, and presents results to the user.

**Characteristics:**
- Simple to implement — subprocess management with stdout parsing.
- Each invocation is stateless; no session persistence between tasks.
- Full task autonomy: Codex handles all tool execution.
- Sandbox level and approval policy set per spawn.
- Suitable for: one-shot coding tasks, CI-style automation, background task execution.

**Example invocation:**
```bash
OPENAI_API_KEY=sk-... codex exec --json --sandbox workspace-write --ask-for-approval never \
  "Refactor the authentication module to use the new TokenStore interface"
```

### Mode 2: `codex app-server` — Long-Lived Daemon

HyperNeo connects to a persistent `codex app-server` instance (stdio or WebSocket), manages multiple threads, and streams incremental output to the UI.

**Characteristics:**
- Supports multi-turn conversations within a thread.
- Streaming text via `item/agentMessage/delta` notifications.
- Thread forking and resumption for conversation branching.
- One daemon can serve multiple HyperNeo sessions (separate threads).
- Higher implementation complexity: JSON-RPC protocol, thread lifecycle management.
- Suitable for: interactive chat-style coding sessions, persistent session history.

**WebSocket launch:**
```bash
OPENAI_API_KEY=sk-... codex app-server --listen ws://127.0.0.1:4500
```

### Mode 3: `codex mcp-server` — Codex as a Tool

HyperNeo's own Claude-based agents call Codex as an MCP tool. HyperNeo remains in the driver's seat; Codex is one callable sub-agent among others.

**Characteristics:**
- HyperNeo retains full agent orchestration control.
- Codex is invoked for specific subtasks (e.g., "implement this function") and returns a result.
- Compatible with HyperNeo's existing MCP infrastructure.
- Codex's autonomous execution is still opaque — HyperNeo only sees the final tool response.
- Suitable for: delegating bounded implementation tasks to Codex from within a HyperNeo-orchestrated session.

---

## Summary Table

| Capability | `codex exec --json` | `codex app-server` | `codex mcp-server` |
|---|---|---|---|
| Transport | Subprocess stdout | stdio or WebSocket | MCP protocol |
| Session persistence | No (ephemeral) | Yes (threads) | No (per call) |
| Streaming text | No (full items only) | Yes (delta notifications) | No |
| Multi-turn | No | Yes | No |
| Concurrency | One task per process | Multiple threads | One task per call |
| HyperNeo controls tools? | No | No | No |
| HyperNeo controls model? | Via `--model` flag | Via `thread/start` params | Via MCP config |
| Sandbox control | `--sandbox` flag | Per-thread config | MCP server config |
| Implementation complexity | Low | High | Medium |
