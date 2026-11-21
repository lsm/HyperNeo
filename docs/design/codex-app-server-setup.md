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

Both goals must be proven by the end-to-end checks in the Verification section
before the implementation merges. Live evidence so far covers messaging and the
app reconnecting after a forwarder restart; the phone connection itself and a
real logout/reboot cycle are still unverified.

Non-goals: queueing (the adapter already queues via `thread/queue/add` with a
CLI fallback), replacing or wrapping the managed daemon, non-macOS support.

## Design

### Opt-in setup command

`hyperneo codex-setup`, macOS only (the CLI refuses elsewhere with a clear
message). Per the issue, setup is opt-in, never automatic. Steps, each idempotent:

1. Migrate any hand-installed bridge (see Migration below): boot out and delete
   the old launchd agents so they cannot fight the built-in one at the next
   login.
2. Ensure the managed daemon runs: `codex app-server daemon start`. Returns
   `alreadyRunning` when up; safe to repeat.
3. Record the bridge in daemon settings (including the prior value of
   `CODEX_APP_SERVER_WS_URL` from `launchctl getenv`, if any) and ask the running
   daemon (over RPC) to start the forwarder now.
4. `launchctl setenv CODEX_APP_SERVER_WS_URL ws://127.0.0.1:47912/rpc`.
5. `codex app-server daemon enable-remote-control`. Persists across daemon
   starts, but restarts the running daemon once, interrupting Codex work in
   flight, so setup warns first; `--no-remote-control` skips it.
6. Tell the user to quit and reopen the Codex app (a running app reads the var
   only at launch).

`hyperneo codex-setup --undo` reverses only what setup owns: restore the recorded
prior env value (or `launchctl unsetenv` if there was none), clear the setting
(the daemon stops the forwarder), quit and reopen the app. The managed daemon
and its remote-control flag are the codex CLI's own state and are left alone;
undo prints the separate command to disable remote control. Undo never
reinstalls migrated launchd agents.

### Login lifecycle

Nothing here survives a reboot on its own: `launchctl setenv` is per login
session and no login job starts the managed daemon. The HyperNeo daemon is the
persistent anchor. Whenever it starts with the bridge setting on, it re-applies
the whole setup: `launchctl setenv`, `codex app-server daemon start`, then the
forwarder. So reboot behavior reduces to "the HyperNeo daemon runs at login",
which is already the product's assumption; setup states that requirement.

Ordering caveat, accepted rather than engineered around: if the Codex app
launches before the HyperNeo daemon at login (for example macOS session restore),
that app instance starts with no env var and falls back to its private server;
refusals return until it is quit and reopened. The extended active-writer
message (below) names that fix. No watcher force-quits the app.

### Migration from the hand-installed bridge

Setup detects the previously documented hand-installed agents (the forwarder
agent and the login setup agent) by label: `launchctl bootout` each, delete
their plists, and report what was removed. The built-in forwarder deliberately
reuses the same port, so the env var the old login job set keeps pointing at a
working bridge; the old forwarder must be gone first or the port is busy.
Remote control is not re-enabled if `remoteControl/status/read` already reports
enabled. Undo does not restore the removed agents; if the user wants the old
hand-installed setup back, undo says so and points at the launchd documentation
rather than reinstalling anything.

### Forwarder inside the daemon

The forwarder replaces the separate launchd job: a small module in
`packages/daemon/src/lib/drivers/` (~40 lines) that listens on `127.0.0.1:47912`
and, per accepted WebSocket connection, opens a connection to the daemon socket
and pipes frames both ways without parsing. The daemon starts it at startup
whenever the bridge setting is on, so it survives HyperNeo restarts without any
launchd job of its own.

The port is a fixed default (47912) stored in the setting. If the port is busy
and is not our own listener, setup fails with instructions (after migration, a
busy port means something else owns it) instead of picking another port: the app
reads the env var at launch, so a drifting port would strand every
already-configured app.

Access control: a TCP listener is not equivalent to the Unix socket it fronts.
The socket sits in `~/.codex` behind user-only file permissions; a loopback
WebSocket is reachable by any local process and, without countermeasures, by
JavaScript in any web page in any browser (browsers happily open
`ws://127.0.0.1`). The forwarder therefore rejects any connection that presents
an `Origin` header: browsers always send one, so pages cannot connect, while
non-browser local clients (the app, the CLI) do not send one. This is a
behavioral guess about the app until the verification pass confirms the app
connects without an `Origin`; if it does send one, the setting carries an
allowlist holding exactly that origin. Local processes without an `Origin` can
still drive the bridge, but they can already reach the daemon socket itself, so
no local boundary is crossed. Daemon-side auth (for example
`--ws-auth capability-token`) is out of scope: the app's token support is
unverified and the env var carries a static URL.

### Version drift

Codex app update that drops `CODEX_APP_SERVER_WS_URL`: the app silently reverts
to its private server and the old refusals return; nothing else breaks. The
existing active-writer rejection in `codex-desktop-adapter.ts` already reports
that the app holds the thread; the message gains one sentence: the app may have
reverted after an update, quit and reopen it or rerun `hyperneo codex-setup`. No
auto-heal loop.

Codex CLI or daemon update: `daemon start` stays idempotent, the socket path has
been stable, and forwarder connections are per-accept, so a daemon restart just
drops the app's connection; the app reconnected on its own within seconds when
this was observed live (forwarder restart; a daemon restart and a full reboot
remain unverified, see Verification). HyperNeo's existing bootstrap fallback
still covers a missing socket.

### Other platforms

macOS only for now. The env injection is `launchctl setenv`, a macOS login
session mechanism; Linux desktops have no session-wide equivalent, and the
Windows app's handling of the env var is unverified. The forwarder module itself
is platform-neutral if this is extended later.

## Verification

The implementation is not done until both goals pass end to end, on a real
machine, after migrating the hand-installed bridge:

1. Messaging: with a thread open in the app, HyperNeo sends, steers and queues
   on it and the app renders each message live; no active-writer refusal.
2. Phone: with remote control enabled on the managed daemon, the phone sees the
   machine online, opens a thread and interacts. (Today only
   `remoteControl/status` reporting enabled and the desktop reconnecting are
   confirmed; the phone itself is not.)
3. Reboot: log out and back in (or reboot), open the Codex app normally, and
   repeat checks 1 and 2 — covering daemon startup re-application, the env var
   being set before the app launches, and the migration having left no old
   agent re-setting state.
4. Browser rejection: a page in a browser cannot open the bridge socket
   (connection refused by the `Origin` rule); the app still connects.
5. Undo: `--undo` unsets the var, stops the forwarder, restores the prior env
   value, and a reboot after undo leaves nothing behind.

## Slices

1. Forwarder module plus daemon startup wiring behind the setting, including the
   `Origin` rule (build and wire in one slice; a few lines over budget is
   acceptable).
2. `hyperneo codex-setup` with `--undo`, `--no-remote-control` and migration of
   the hand-installed agents.
3. Active-writer message extension.

## Open questions

1. Is port 47912 fine as the permanent default?
2. Remote control inside setup (skippable with a flag) versus a separate
   explicit step, given it restarts the managed daemon once?
3. Should the desktop app ever prompt to run this setup, or does the CLI stay
   the only door?
4. Is the login-ordering caveat (an app instance restored before the HyperNeo
   daemon keeps its private server until quit and reopen) acceptable, or does
   setup need to warn about macOS session restore explicitly?
