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

### Setup flow: ask once, then do it

macOS only; elsewhere the driver skips the check and the CLI refuses with a
clear message.

When the Codex driver finds the shared setup missing — at daemon startup with
the driver enabled, and again on first Codex use, it checks the bridge
setting, the token file, the env var (via `launchctl getenv`), the managed
daemon running and remote control enabled — it changes nothing yet. Neo asks
the user once, on the existing question card, in plain words: HyperNeo needs
to set up the shared Codex server and restart the Codex app (and, for remote
control, restart the managed Codex daemon), which interrupts anything running
in them at that moment — is that OK? No new UI.

- On yes, HyperNeo runs the steps below and then quits and reopens the Codex
  app itself; the user does nothing.
- On no, nothing changes, the decline is recorded in the setting, and the
  driver does not ask again until the user runs `hyperneo codex-setup`, which
  clears the decline and runs the same steps.

Idle gate: every disruptive cutover — stopping the old hand-installed
forwarder (migration), `enable-remote-control`'s daemon restart, stopping the
built-in forwarder and quitting/reopening the app (undo) — happens only when
no Codex turn is running in the managed daemon, re-checked immediately before
each cutover step. Post-setup, HyperNeo, desktop and phone turns all execute
there, so one check covers all three. Between the check and the finished
cutover, HyperNeo holds its own new Codex sends (the work admission gate) and
the cutover takes seconds; a turn started from the app or phone inside that
seconds-wide window is the one residual race, disclosed in the question text
(it reconnects on its own after setup, as observed) and listed as an open
question for the human. If Codex work is in flight when the user says yes,
HyperNeo runs every non-disruptive step at once and holds the cutovers,
re-checking as each turn completes.

Fresh machine: before setup, the app runs its own private server, so its turns
are invisible to the daemon-side idle check. The simplest safe rule applies:
on fresh setup the app quit/reopen is itself the user-approved interruption —
the question says plainly that restarting the Codex app interrupts anything
running in it — and no further detection of in-app turns is attempted.

The question's state is durable, in the daemon settings beside the bridge
setting: `asked` (a pending, unanswered question is reused after a restart,
never duplicated), `approved` (an approved but deferred setup resumes on the
next daemon start or Codex use, at idle), `declined` (no further question
until a manual `codex-setup`), or unset. The same settings record holds
whether remote control is `enabled` or `skipped`: after an explicit
`--no-remote-control`, the missing-setup check treats remote control as a
configured choice and never prompts about it again.

The same idle gate applies to both manual commands: `hyperneo codex-setup`
waits for idle before the cutovers instead of only warning, and so does
`--undo`.

Steps, each idempotent:

1. Migrate any hand-installed bridge (see Migration below): at idle, boot out
   and delete the old launchd agents so they cannot fight the built-in one at
   the next login; until then the old forwarder keeps serving the app.
2. Ensure the managed daemon runs: `codex app-server daemon start`. Returns
   `alreadyRunning` when up; safe to repeat.
3. Record the bridge in daemon settings, generate the per-user token into its
   own storage file (see Forwarder inside the daemon), and start the forwarder.
4. `launchctl setenv CODEX_APP_SERVER_WS_URL` to the bridge URL, which embeds
   the per-user token described under Forwarder inside the daemon.
5. `codex app-server daemon enable-remote-control`. Persists across daemon
   starts, but restarts the running daemon once, interrupting Codex work in
   flight — hence the idle gate above. `--no-remote-control` skips it in both
   paths and records the skip as the configured choice.
6. Quit and reopen the Codex app (a running app reads the var only at launch);
   HyperNeo does this itself after the steps, subject to the same idle gate.

The setting also holds the one recorded original env value, written before any
`launchctl setenv` runs so a partial failure leaves consistent state. Recording
is ownership-aware and happens only once: on first setup, the current value of
`CODEX_APP_SERVER_WS_URL` is recorded if — and only if — it is not the bridge
URL (the migrated installation's value is the bridge URL of the removed
forwarder, which undo must never restore). A repeated setup keeps the existing
record untouched, so the original survives any number of reruns.

`hyperneo codex-setup --undo` reverses only what setup owns, with the same
idle gate covering the forwarder stop and the app quit/reopen: restore the
recorded original (or `launchctl unsetenv` if none was recorded), consume the
record, clear the setting and delete the token file (the daemon stops the
forwarder), record an opt-out so the driver never sets the bridge up again or
asks on its own, and quit and reopen the Codex app itself. A later manual
`hyperneo codex-setup` clears the opt-out. The managed daemon and its
remote-control flag are the codex CLI's own state and are left alone; undo
prints the separate command to disable remote control. Undo never reinstalls
migrated launchd agents and never restores a bridge URL.

### Login lifecycle

Nothing here survives a reboot on its own: `launchctl setenv` is per login
session and no login job starts the managed daemon. The HyperNeo daemon is the
persistent anchor. Whenever it starts with the bridge setting on, it re-applies
the whole setup: `launchctl setenv` (rebuilding the URL from the token file),
`codex app-server daemon start`, then the forwarder. So reboot behavior reduces
to "the HyperNeo daemon runs at login", which is already the product's
assumption; setup states that requirement.

Ordering caveat, accepted rather than engineered around: if the Codex app
launches before the HyperNeo daemon at login (for example macOS session restore),
that app instance starts with no env var and falls back to its private server;
refusals return until it is quit and reopened. The extended active-writer
message (below) names that fix. No watcher force-quits the app.

### Migration from the hand-installed bridge

Setup detects the previously documented hand-installed agents (the forwarder
agent and the login setup agent) by label: `launchctl bootout` each, delete
their plists, and report what was removed. The old forwarder must be gone first
or the port is busy, which is why migration runs before the forwarder starts.
Setup then replaces the old login job's env var with the tokened bridge URL;
the app picks that up on its next launch (step 6). The value the old job had
set is the bridge URL of the removed forwarder, so it is not recorded as an
original. Remote control is not re-enabled if `remoteControl/status/read`
already reports enabled. Undo does not restore the removed agents; if the user
wants the old hand-installed setup back, undo says so and points at the launchd
documentation rather than reinstalling anything.

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
The socket sits in `~/.codex` behind user-only file permissions; a bare
loopback listener would be reachable by every local user and by JavaScript in
any web page. The bridge therefore requires a per-user token: the bridge URL is
`ws://127.0.0.1:47912/rpc?token=<token>`, and the forwarder closes any
connection whose token does not match, before any byte reaches the daemon
socket. The app presents the token without cooperation — it connects to
exactly the URL the env var gives it — and a browser page cannot guess it, so
this one mechanism keeps both other local users and browsers out. Daemon-side
auth on the Codex server itself (for example `--ws-auth capability-token`)
stays out of scope: the app's support for it is unverified, while the
token-in-URL form needs none.

Token storage: the token lives in a dedicated file inside the daemon's data
directory, never in the settings record or the database (a custom database
location can point anywhere). The file is written with mode 0600 and its
parent directory with 0700; the daemon re-checks both at every startup and
refuses to start the bridge if either is more permissive and cannot be
tightened. The setting holds only `enabled`, the port and the recorded
original env value.

Token delivery: the URL reaches the app through its process environment, and
the app offers no other input — the bundle reads
`process.env.CODEX_APP_SERVER_WS_URL ?? hostConfig.websocket_url`, and for
local hosts `websocket_url` has no local config-file source, so the env var is
the only lever. Session-wide env for user-launched apps is settable only
through `launchctl setenv`, which takes the value as a command-line argument
(reading subcommands from stdin is not supported), and process arguments are
visible to other local users. So the token crosses a process argument list for
the lifetime of each `launchctl setenv` run — milliseconds, once per login when
the daemon re-applies setup. There is no public mechanism that avoids this:
the alternatives are a helper speaking launchd's undocumented XPC protocol
(fragile across macOS releases) or launching the app only through HyperNeo so
the token rides the spawn environment (breaks every normal Dock/Finder launch).
Proposed: accept the window as a known residual risk (Neo, 2026-11-21); the
human confirms or rejects at sign-off — see Open questions. A stolen token
works only until the next `codex-setup` regenerates it; rotation is the manual
redress. No XPC helper will be built — it would rely on non-public launchd
behaviour.

Logging: the token never appears in logs. The forwarder logs connection
counts and JSON-RPC method names only, never URLs or request targets; anything
in HyperNeo that logs the bridge URL strips the query first. Verification
includes a log scan for the token.

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
4. Token gate: a connection with a missing or wrong token is refused before any
   frame is forwarded; the app still connects with the URL it was given. The
   token file is mode 0600 with a 0700 parent, and the bridge refuses to start
   on looser permissions. After a full pass, the token appears in no HyperNeo
   or forwarder log.
5. Ask-first setup: on a machine with no setup and no decline on record, first
   Codex use (or daemon startup with the driver enabled) surfaces the one
   question card and changes nothing before the answer. On yes, the steps run,
   the app is quit and reopened by HyperNeo, and messaging works without a
   refusal; with Codex work in flight at the yes, the daemon restart and app
   quit wait for idle and then happen on their own. On no, nothing changes and
   no further question appears on later daemon restarts or Codex use until a
   manual `codex-setup`. After `--undo`, the same silence holds until a manual
   `codex-setup`. With Codex work in flight, setup, migration and undo all
   defer their cutovers and no active connection drops; a pending question
   survives a daemon restart without being asked twice; an approved but
   deferred setup resumes on its own; and after `--no-remote-control` the
   missing-setup check never prompts about remote control again.
6. Undo: from the migrated installation, `--undo` unsets the var (it does not
   restore the dead bridge URL of the removed forwarder); from an installation
   where the var held a distinct pre-existing value, `--undo` restores that
   value. Repeated setup before undo preserves the recorded original each time.
   A reboot after undo leaves nothing behind.

## Slices

1. Forwarder module plus daemon startup wiring behind the setting, including
   the token gate, token file storage and log redaction (build and wire in one
   slice; a few lines over budget is acceptable).
2. Shared setup steps as one code path: the driver's automatic check at daemon
   startup and first Codex use, and `hyperneo codex-setup` with `--undo`,
   `--no-remote-control` and migration of the hand-installed agents.
3. Active-writer message extension.

## Open questions

1. Token delivery residual risk: the only public session-env mechanism
   (`launchctl setenv`) exposes the token in that process's arguments for the
   milliseconds it runs, once per login. Proposed: accept as a known residual
   risk (Neo, 2026-11-21) — a stolen token works only until the next
   `codex-setup`; no XPC helper (non-public launchd behaviour). The human
   confirms or rejects this at sign-off.
2. Is port 47912 fine as the permanent default?
3. Should the desktop app ever prompt to run this setup, or does the CLI stay
   the only door?
4. Is the login-ordering caveat (an app instance restored before the HyperNeo
   daemon keeps its private server until quit and reopen) acceptable, or does
   setup need to warn about macOS session restore explicitly?
5. Cutover race: a turn started from the Codex app or phone in the
   seconds-wide window between the idle re-check and a cutover step is
   interrupted (post-setup it reconnects on its own; on fresh setup it is the
   user-approved app restart). Disclosed in the question text; accept, or is a
   stronger bound wanted?
