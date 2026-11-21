# Built-in Codex app-server setup for the Codex driver

## 中文摘要

目标：把现在手工安装的 Codex app-server 共享配置变成 HyperNeo Codex driver 的内置功能。当前手工方案是一个 10 行 TCP-to-Unix socket 转发器（launchd 管理）加一个登录时设置环境变量的脚本，让 Codex app 连到 HyperNeo 用的同一个 app-server 守护进程。这样 HyperNeo 可以给 app 里开着的线程发消息，手机也能通过远程控制连到电脑。本设计把转发器逻辑放进 HyperNeo 守护进程，用 `codex app-server daemon enable-remote-control` 打开远程控制，提供 opt-in 配置和干净的撤销路径。

## Problem

Today the Codex app and HyperNeo use separate Codex app-server processes. The app spawns its own private server (`codex app-server --listen stdio://`) which holds thread-writer locks. HyperNeo connects to the managed daemon (`~/.codex/app-server-control/app-server-control.sock`). When the app has a thread open, HyperNeo gets "already has an active writer" refusals.

The fix (verified 2026-11-20 on the author's machine):

1. Run a TCP-to-Unix forwarder on `127.0.0.1:47912` so the app (which only accepts `ws://` URLs) can reach the managed daemon (which only listens on a Unix socket).
2. Set `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:47912/rpc` so the app connects to the forwarder instead of spawning its own server.
3. Run `codex app-server daemon enable-remote-control` so the phone can reach the laptop through ChatGPT remote control.

This works but is hand-installed: a launchd plist for the forwarder, a launchd plist for a login script, and a hard-coded path to a test directory. It does not survive reinstalls, and other HyperNeo users do not get it.

## Decision

Move the forwarder into the HyperNeo daemon. Add opt-in setup that:

1. Starts a TCP forwarder inside the HyperNeo daemon process (no separate launchd job).
2. Sets `CODEX_APP_SERVER_WS_URL` via `launchctl setenv` on macOS when the daemon starts (and unsets it on clean shutdown).
3. Runs `codex app-server daemon enable-remote-control` once (idempotent; persists across daemon restarts).
4. Provides a single `hyperneo codex-setup --undo` command to reverse everything.

## Why the forwarder belongs in the daemon

The forwarder is 10 lines of Node.js (`net.createServer` piping TCP to Unix socket). The daemon already runs a WebSocket client to the same socket. Moving it in removes the launchd dependency, the hard-coded path, and the separate process lifecycle. The daemon can also detect when the socket disappears (daemon restart) and rebind the forwarder.

## Design

### Forwarder module

New file: `packages/daemon/src/lib/drivers/codex-app-forwarder.ts`

- Listens on `127.0.0.1:47912` (configurable via `CODEX_FORWARDER_PORT` env var).
- Pipes incoming TCP connections to `~/.codex/app-server-control/app-server-control.sock`.
- Logs one line on bind, one line on error.
- No authentication (same exposure as the daemon socket itself).

### Setup orchestration

New file: `packages/daemon/src/lib/drivers/codex-app-setup.ts`

Called once at daemon startup on macOS when `HYPERNEO_CODEX_APP_SETUP=1` (opt-in env var):

1. Check if `CODEX_APP_SERVER_WS_URL` is already set to the expected value. If yes, skip.
2. Run `launchctl setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:47912/rpc`.
3. Run `codex app-server daemon start` (idempotent; returns `alreadyRunning` if up).
4. Run `codex app-server daemon enable-remote-control` (idempotent; persists across restarts).
5. Start the forwarder.

On daemon shutdown (SIGTERM): if the daemon started the forwarder, stop it. Leave the env var set (the app may still be running). Document this in the setup output.

### Undo

`hyperneo codex-setup --undo` (or a daemon RPC):

1. Stop the forwarder.
2. `launchctl unsetenv CODEX_APP_SERVER_WS_URL`.
3. Print: "Quit and reopen the Codex app to return to normal mode."

### Platform behavior

| Platform | Behavior |
|----------|----------|
| macOS | Full setup: forwarder + env var + remote control. |
| Linux | Forwarder works (same TCP-to-Unix pattern). `launchctl` does not exist; use `/etc/environment` or systemd user units. Document as manual step. |
| Windows | Forwarder works (named pipes instead of Unix sockets). Env var via `setx`. Document as manual step. |

### Version changes

- **Codex app update**: If the app stops reading `CODEX_APP_SERVER_WS_URL`, it falls back to its own server. HyperNeo detects this when thread-writer locks appear under a non-daemon PID. Log a warning; do not crash.
- **Daemon update**: `codex app-server daemon update` restarts the daemon. The forwarder detects the socket disappearing and rebinds on next connection. The app reconnects automatically (verified in testing).
- **HyperNeo update**: The forwarder and setup are part of the daemon binary. No external files to update.

## What happens to the hand-installed setup

The launchd plists (`ai.hyperneo.codex-app-forwarder`, `ai.hyperneo.codex-app-setup`) and the scripts in the test directory are removed. The built-in setup replaces them. The undo command cleans up both the old and new state.

## Files to change

| File | Change |
|------|--------|
| `packages/daemon/src/lib/drivers/codex-app-forwarder.ts` | New. TCP-to-Unix forwarder. |
| `packages/daemon/src/lib/drivers/codex-app-setup.ts` | New. Setup orchestration and undo. |
| `packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts` | Call setup at daemon startup when opt-in env var is set. |
| `packages/cli/main.ts` | Add `hyperneo codex-setup [--undo]` command. |
| `packages/daemon/tests/unit/drivers/codex-app-forwarder.test.ts` | Unit tests for forwarder bind, pipe, error handling. |
| `packages/daemon/tests/unit/drivers/codex-app-setup.test.ts` | Unit tests for setup idempotency, undo, platform guards. |

## Test plan

**Forwarder unit tests.**
- Bind to port; connect to fake Unix socket; verify bytes flow both ways.
- Socket disappears; next connection triggers rebind attempt.
- Port already in use; log error, do not crash.

**Setup unit tests.**
- `HYPERNEO_CODEX_APP_SETUP` unset: no-op.
- Env var already set to expected value: skip `launchctl setenv`.
- `codex app-server daemon start` returns `alreadyRunning`: continue without error.
- Undo: forwarder stopped, env var unset, instruction printed.

**Integration test (manual, on laptop).**
- Set `HYPERNEO_CODEX_APP_SETUP=1`, start daemon.
- Open Codex app. Verify in Activity Monitor: no `codex app-server --listen stdio://` child process.
- From HyperNeo, send a message to a thread open in the app. Verify delivery.
- From phone, verify remote connection to laptop works.
- Run `hyperneo codex-setup --undo`. Quit and reopen app. Verify app spawns its own server again.

## Open questions for the human

1. Should the setup be opt-in (env var) or automatic when the daemon detects the Codex app is installed?
2. Should the forwarder port be fixed at 47912 or dynamic?
3. On Linux/Windows, is a manual setup document sufficient for v1, or should systemd/user units be generated?
4. Should the daemon auto-detect when the app falls back to its own server (thread-writer locks under a non-daemon PID) and warn the user?
