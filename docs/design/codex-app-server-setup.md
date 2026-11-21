# Built-in Codex app-server setup

Issue #11417. Make the shared Codex app-server setup a built-in Codex-driver
feature instead of a hand-installed set of launchd jobs and scripts.

## Problem

The Codex desktop app spawns a private `codex app-server --listen stdio://` at
launch and takes the writer lock for every thread it opens. HyperNeo's Codex
driver talks to the managed daemon at
`~/.codex/app-server-control/app-server-control.sock`
(`packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts`), so any
thread open in the app refuses HyperNeo with `thread ... already has an active
writer` until the app quits.

The app also accepts an external server: it reads `CODEX_APP_SERVER_WS_URL`
(undocumented, verified in the app bundle) and connects over WebSocket instead
of spawning its own server. With both sides on the managed daemon, all writer
locks sit in one process and the refusals disappear; send, steer and queue were
verified live in this mode. But the app only speaks `ws://` (TCP) and the
managed daemon only listens on a Unix socket, so a byte-pumping forwarder is
needed. Today that forwarder is a hand-installed launchd agent, a login agent
sets the env var via `launchctl setenv` and starts the daemon, and remote
control was enabled by a manual `codex app-server daemon enable-remote-control`
call. Without that last step the phone loses its remote connection, because the
managed daemon ships with remote control off while the app's private server has
it on.

## Goals

1. HyperNeo can always message Codex app threads, with no active-writer refusals.
2. The phone's remote connection to the Codex app keeps working.

Non-goals: queueing (the adapter already queues via `thread/queue/add` with a
CLI fallback), replacing or wrapping the managed daemon, non-macOS support.

## Design

### Opt-in setup command

`hyperneo codex-setup`, macOS only (the CLI refuses elsewhere with a clear
message). Per the issue, setup is opt-in, never automatic. Steps, each idempotent:

1. Ensure the managed daemon runs: `codex app-server daemon start`. Returns
   `alreadyRunning` when up; safe to repeat.
2. Record the bridge in daemon settings and ask the running daemon (over RPC) to
   start the forwarder now.
3. `launchctl setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:47912/rpc`.
4. `codex app-server daemon enable-remote-control`. Persists across daemon
   starts, but restarts the running daemon once, interrupting Codex work in
   flight, so setup warns first; `--no-remote-control` skips it.
5. Tell the user to quit and reopen the Codex app (a running app reads the var
   only at launch).

`hyperneo codex-setup --undo` reverses it: `launchctl unsetenv`, clear the
setting (the daemon stops the forwarder), quit and reopen the app. The managed
daemon and its remote-control flag are the codex CLI's own state and are left
alone; undo prints the separate command to disable remote control.

### Forwarder inside the daemon

The forwarder replaces the separate launchd job: a small module in
`packages/daemon/src/lib/drivers/` (~40 lines) that listens on `127.0.0.1:47912`
and, per accepted WebSocket connection, opens a connection to the daemon socket
and pipes frames both ways without parsing. The daemon starts it at startup
whenever the bridge setting is on, so it survives HyperNeo restarts without any
launchd job of its own.

The port is a fixed default (47912) stored in the setting. If the port is busy
and is not our own listener, setup fails with instructions instead of picking
another port: the app reads the env var at launch, so a drifting port would
strand every already-configured app.

Exposure: loopback, no auth — the same exposure the daemon socket already has
(any local process can drive the daemon). No new capability is opened.

### Version drift

Codex app update that drops `CODEX_APP_SERVER_WS_URL`: the app silently reverts
to its private server and the old refusals return; nothing else breaks. The
existing active-writer rejection in `codex-desktop-adapter.ts` already reports
that the app holds the thread; the message gains one sentence: the app may have
reverted after an update, quit and reopen it or rerun `hyperneo codex-setup`. No
auto-heal loop.

Codex CLI or daemon update: `daemon start` stays idempotent, the socket path has
been stable, and forwarder connections are per-accept, so a daemon restart just
drops the app's connection; the app reconnects on its own (observed live within
seconds). HyperNeo's existing bootstrap fallback still covers a missing socket.

### Other platforms

macOS only for now. The env injection is `launchctl setenv`, a macOS login
session mechanism; Linux desktops have no session-wide equivalent, and the
Windows app's handling of the env var is unverified. The forwarder module itself
is platform-neutral if this is extended later.

## Slices

1. Forwarder module plus daemon startup wiring behind the setting (build and
   wire in one slice; a few lines over budget is acceptable).
2. `hyperneo codex-setup` with `--undo` and `--no-remote-control`.
3. Active-writer message extension.

## Open questions

1. When the HyperNeo daemon is not running, the env var points at a dead port
   and the app cannot connect until it returns (the app retries, running work
   lives in the Codex daemon, so nothing is lost). Acceptable as-is, or should
   setup warn when HyperNeo is not installed as a login service?
2. Is port 47912 fine as the permanent default?
3. Remote control inside setup (skippable with a flag) versus a separate
   explicit step, given it restarts the managed daemon once?
4. Should the desktop app ever prompt to run this setup, or does the CLI stay
   the only door?
