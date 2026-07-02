# GitHub Copilot CLI Capabilities Report

**Date:** 2026-03-14
**Version investigated:** GitHub Copilot CLI 1.0.2
**Status:** Generally Available (GA as of 2026-02-25)

---

## Overview

The new GitHub Copilot CLI (`copilot`) is a standalone binary released in public preview on
2025-09-25, reaching general availability on 2026-02-25. It replaces the deprecated
`gh copilot` extension (deprecated 2025-10-25) and is a fully agentic terminal assistant.

**Binary location on this machine:** `/usr/local/bin/copilot`
**Version:** 1.0.2
**Auth status:** Authenticated as `lsm` on `github.com`

---

## Installation

```bash
# Install via GitHub CLI extension installer
gh extension install github/copilot

# Or direct binary download from:
# https://github.com/github/copilot-cli/releases

# Verify
copilot --version
# GitHub Copilot CLI 1.0.2
```

---

## Command Reference

### Top-level Commands

| Command | Description |
|---------|-------------|
| `copilot` | Launch interactive TUI |
| `copilot -p "<prompt>"` | Non-interactive scripting mode |
| `copilot --acp` | ACP server mode (stdio, JSON-RPC 2.0) |
| `copilot --acp --port 8080` | ACP server mode (TCP) |
| `copilot init` | Initialize AGENTS.md instructions |
| `copilot login [--host]` | OAuth device flow authentication |
| `copilot plugin` | Manage plugins |
| `copilot update` | Download latest version |
| `copilot version` | Show version |

### Key Flags for Programmatic Use

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | Prompt text (non-interactive mode) |
| `--model <id>` | Select model |
| `--allow-all` / `--yolo` | Skip all permission prompts |
| `--no-ask-user` | Prevent agent from asking clarifying questions |
| `--autopilot` | Enable autonomous multi-step continuation |
| `--output-format json` | NDJSON output (one JSON object per line) |
| `-s, --silent` | Suppress stats, output only agent response |
| `--resume <sessionId>` | Resume a previous session |
| `--no-auto-update` | Disable auto-update (for CI/automation) |
| `--acp` | Start as ACP server (JSON-RPC 2.0 over NDJSON) |
| `--port <n>` | ACP server TCP port (with `--acp`) |
| `--cwd <path>` | Working directory |

### Interactive Session Commands

| Slash Command | Description |
|---------------|-------------|
| `/model` | Switch model |
| `/mcp` | MCP server management |
| `/diff` | Show file diff |
| `/review` | Review changes |
| `/fleet` | Parallelized subagents |
| `/tasks` | Task management |
| `/plan` | Planning mode |
| `/research` | Research mode |
| `/compact` | Compact conversation |
| `/share` | Share session |
| `/ide` | IDE integration |

---

## IPC Mechanisms

### Option A: NDJSON Output Mode (Primary for POC)

Invoke as subprocess with `--output-format json`:

```bash
copilot -p "write a hello world in python" \
  --output-format json \
  --silent \
  --allow-all \
  --model claude-sonnet-4.6 \
  --no-auto-update
```

**Output:** One JSON object per line on stdout. Events include:
- `user.message` — input prompt (with transformed content, timestamps, IDs)
- `assistant.turn_start` — turn begins
- `assistant.reasoning_delta` — streaming reasoning tokens (`ephemeral: true`)
- `assistant.message_delta` — streaming response tokens (`ephemeral: true`)
- `assistant.message` — final complete message (content, toolRequests, reasoningText)
- `assistant.reasoning` — complete reasoning block
- `assistant.turn_end` — turn complete
- `result` — session summary (sessionId, exitCode, usage stats)

**Multi-turn:** Resume with `--resume <sessionId>` from the `result` event.

### Option B: ACP Server Mode (Recommended for Production)

Start as long-lived ACP server:

```bash
copilot --acp           # stdio mode (NDJSON over stdin/stdout)
copilot --acp --port 8080  # TCP mode
```

Uses **JSON-RPC 2.0** as the base protocol over NDJSON transport. Available since
public preview on 2026-01-28.

**Capabilities:**
- Initialize connections and discover capabilities
- Create isolated sessions with custom working directories
- Send prompts with text, images, and context resources
- Receive streaming updates during agent operations
- Respond to permission requests for tool execution
- Cancel operations and manage session lifecycle

The GitHub Copilot SDK (`github/copilot-sdk`) wraps this ACP protocol and is the
intended API for building IDE integrations and transparent backends.

---

## Authentication Methods

Precedence order:
1. **Environment variables:** `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`
2. **Stored credentials** from `copilot login` (system credential store or `~/.copilot/` fallback)
3. **Fine-grained PATs** with "Copilot Requests" permission
4. **OAuth tokens** from the GitHub Copilot CLI app
5. **OAuth tokens** from `gh` CLI app (classic `ghp_` PATs are NOT supported)

**Note:** The existing `gh auth login` credentials at `~/.config/gh/hosts.yml` are
recognized by the CLI. No additional login needed if `gh` is authenticated.

**Local config:** `~/.copilot/config.json`
```json
{
  "banner": "never",
  "trusted_folders": ["/Users/lsm/focus/neokai"],
  "render_markdown": true,
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "alt_screen": false
}
```

---

## Available Models

| Model ID | Description |
|----------|-------------|
| `claude-opus-4.6` | Claude Opus 4.6 (most capable) |
| `claude-opus-4.6-fast` | Claude Opus 4.6 Fast |
| `claude-opus-4.5` | Claude Opus 4.5 |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 (balanced) |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4.5` | Claude Haiku 4.5 (fast) |
| `gemini-3-pro-preview` | Gemini 3 Pro Preview |
| `gpt-5.4` | GPT-5.4 |
| `gpt-5.3-codex` | GPT-5.3 Codex (best for coding) |
| `gpt-5.2-codex` | GPT-5.2 Codex |
| `gpt-5.2` | GPT-5.2 |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max |
| `gpt-5.1-codex` | GPT-5.1 Codex |
| `gpt-5.1` | GPT-5.1 |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini |
| `gpt-5-mini` | GPT-5 Mini (fast & efficient) |
| `gpt-4.1` | GPT-4.1 |

Model selection:
- `--model <id>` flag
- `COPILOT_MODEL` environment variable
- `~/.copilot/config.json` `model` field

---

## NDJSON Event Format

Each event line:
```json
{
  "type": "assistant.message_delta",
  "data": { "delta": "Hello" },
  "id": "evt_abc123",
  "timestamp": "2026-03-14T10:00:00.000Z",
  "parentId": "turn_xyz",
  "ephemeral": true
}
```

### `result` event (final):
```json
{
  "type": "result",
  "data": {
    "sessionId": "session_abc123",
    "exitCode": 0,
    "usage": {
      "premiumRequests": 1,
      "totalApiDurationMs": 5234,
      "codeChanges": {
        "additions": 42,
        "deletions": 3
      }
    }
  },
  "id": "result_001",
  "timestamp": "2026-03-14T10:00:05.234Z"
}
```

Exit codes: `0` = success, non-zero = error.

---

## Tool Capabilities

The Copilot CLI has its own built-in tools that it executes autonomously:
- **File operations:** Read, write, edit files
- **Shell commands:** Run bash/shell commands
- **GitHub API:** PR comments, issue operations, file diffs
- **Git operations:** Clone, checkout, branch, push

With `--allow-all`, all tool executions are auto-approved without prompts.

**Key difference from the legacy callback adapter:** The CLI executes tools internally;
HyperNeo does NOT intercept or execute them. This is a "black box" approach to tool execution.

---

## Version Checking

```bash
copilot --version
# GitHub Copilot CLI 1.0.2

copilot version
# v1.0.2
```

Use `--no-auto-update` to prevent version upgrades in CI/automation environments.

---

## Limitations & Considerations

1. **No tool callback interception** — The CLI handles all tool execution autonomously.
   HyperNeo cannot inject its own tool execution logic.
2. **Working directory scope** — The CLI operates on the filesystem at `cwd`. Worktrees
   should pass `--cwd` to scope file operations.
3. **Session persistence** — Sessions survive only as long as the Copilot backend retains
   them. Long-running sessions may expire.
4. **Rate limits** — Copilot has per-user rate limits. Premium requests may be throttled.
5. **Private repos** — Works with private repos if the GitHub token has `repo` scope.
6. **Binary updates** — CLI auto-updates by default. Use `--no-auto-update` in production.
7. **No sandboxing** — With `--allow-all`, the CLI can execute arbitrary shell commands.
   Only use in trusted environments (e.g., isolated worktrees).

---

## References

- [GitHub Copilot CLI GA announcement](https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/)
- [Programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- [ACP server docs](https://docs.github.com/en/copilot/reference/acp-server)
- [ACP preview announcement](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
- [copilot-cli releases](https://github.com/github/copilot-cli/releases)
