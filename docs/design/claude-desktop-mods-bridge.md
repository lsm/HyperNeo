# Claude Desktop mods bridge

## Controller before driver wiring

The controller reuses the verified native endpoint and local reply-destination
gates. Queue/stop additionally require a recently authenticated plugin exchange
and a matching Desktop owner PID/active instance. A stored journal alone is not
a live management endpoint. Unknown turn IDs stay unsupported; there is no
headless fallback. Queue returns an own outbox ID with delivery unconfirmed.

Stop targets the exact observed turn ID and waits for its completion event in
that same instance. Only an observed aborted completion yields `stopped: true`;
API resolution, normal completion, rejection, owner change, disconnect and
timeout retain their distinct factual outcomes. Closing the runtime wakes waiters.

Own pending outbox input can be withdrawn even when Desktop is unavailable.
Sender/session/native-queue isolation and the existing pending-only CAS remain
authoritative. Claimed inputs cannot be reported as successfully withdrawn.

Command state, API receipt, observed session state and matching stop completion
are reported to the original local session through the existing mailbox with
system/peer provenance. Session observation does not correlate a turn with a
particular submitted prompt. Report-state markers and mailbox entries commit
in the same SQLite transaction; queue/withdraw also include that report in
their transaction. Replays/reopens do not repeat committed reports. Finalized
commands do not subscribe their senders to unrelated future turns. This is a
Build slice; daemon startup and adapter capability wiring follow separately.

## Explicit runtime lifecycle

The runtime factory is built separately from driver wiring. It is off unless
`HYPERNEO_CLAUDE_DESKTOP_MODS=1`. Enabling it also requires an absolute
`HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE` in a private, user-owned directory
(for example a dedicated directory under HyperNeo's data area). The operator
explicitly enables the plugin and sets its `connectionFile` to that same path
through supported plugin configuration; HyperNeo never edits Desktop private settings.

The factory acquires the existing `DatabaseLock` protocol for publication,
creates a fresh private Unix socket/token, then atomically publishes a mode-0600
connection file. A concurrent runtime cannot take that path. Shutdown drains the
transport and removes only its own published inode. After a crash, the existing
stale-PID lock protocol allows the next runtime to replace the old pointer.

The plugin retries reading this file if it is initially absent/invalid or a
transport request fails. It keeps its instance, command-ID deduplication and
unacknowledged lifecycle/receipt events across daemon reconnects. It does not
wait for an old HTTP request when a new session starts, and ignores old-instance
responses. Durability across a plugin crash is provided by daemon journal/outbox
fencing, not by replaying uncertain prompts into a new instance.

Each authenticated exchange uses the same verified owner's idle fact to
bootstrap unknown lifecycle state, commits the journal and outbox first, then
notifies subscribers and awaits optional durable reporting before returning the
ACK. Report failure causes retry; consumers must use stable identities when
persisting reports. API resolution remains distinct from observed execution or
turn termination. Native Desktop queued-message cancellation remains unsupported.

These are the opt-in client and private transport Build slices of #7350. The
durable outbox and driver wiring follow separately; installing these slices alone
does not add driver capabilities. The verified persistent peer inbox from #7354
continues to carry send/steer and delayed replies without changing their origin.

## Public API boundary

The standalone plugin is `packages/daemon/claude-desktop-bridge`. Claude Code loads
its TypeScript directly. It uses only the documented mods API:

- `$.turn.abort({ turnId })` stops that exact turn. A resolved command is an API
  receipt; `turn.complete` with `reason: aborted` is the separate stop fact.
- `$.prompt.submit({ text })` submits the next turn, waiting while another turn is
  busy. Claude records plugin provenance. The body quotes the peer's `from` and
  text and explicitly says it is peer input, not human approval. It never passes
  `asUser` or claims native peer provenance for plugin-submitted input.
- `session.start`, `session.end`, `turn.start` and `turn.complete` report lifecycle
  facts. Completion/end flush immediately as well as through the timer.
- `$.http.fetch` with `socketPath` exchanges commands over our own HTTP/UDS
  protocol. This is not a Claude Desktop private IPC protocol.

Public references: [mods reference](https://code.claude.com/docs/en/plugins/mods/reference)
and [plugin configuration](https://code.claude.com/docs/en/plugins/manifest-reference#user-configuration).
Manifest validation and engine probes use Desktop's bundled Claude Code 2.1.299.
CLI-engine verification does not substitute for installed Desktop/UI verification.

## Explicit enablement

Nothing connects until the operator enables the plugin and sets both `enabled:
true` and `connectionFile` through the plugin's documented `userConfig`. Their
defaults are `false` and empty. The connection file names an absolute Unix socket
and a pairing token of at least 32 characters. The daemon integration will own
and validate the private directory, socket and connection file. No existing
Claude credential is read or reused; this plugin does not install itself or edit
Desktop settings.

For isolated CLI tests, the public `--plugin-dir` flag loads the directory and
`--settings` supplies `pluginConfigs["hyperneo-desktop-bridge@inline"].options`.
The options are `{ enabled: true, connectionFile: "/absolute/private/bridge.json" }`.
The file has `{ "socketPath": "/absolute/private/bridge.sock", "token": "..." }`.

## Bridge protocol v1

POST `/bridge/exchange` over the configured socket uses `Authorization: Bearer
<pairing token>`. Its body is `{ version: 1, sessionId, instanceId, events }`.
Events have monotonic `sequence`, `kind` and event-specific facts. Replies are
`{ ack, command? }`; ack cannot exceed the highest sequence in that request.
The server must persist facts before acknowledging them and validate the live
Desktop owner before returning commands. These server obligations are not
implemented by the plugin client itself.

A command contains a unique `id`, the exact `instanceId`, and either
`{ kind: "stop", turnId }` or `{ kind: "submit", from, text }`. The client records
command IDs before calling the API and does not replay duplicate effects within
its instance. Pending submission promises do not block stop commands. HTTP
failures retain unacknowledged events; session changes fence old responses and
late command results. `/clear` or `/resume` changes are detected by reading the
current session ID, without assuming another `session.start` event.

The client journal is in memory. On plugin/process restart the new instance must
be reconciled by the daemon; a missing receipt means unknown, never permission
to blindly replay a possibly accepted prompt. This slice makes no durability or
completion claim across process crashes.

## Withdrawal

There is no public external cancellation API for Desktop's native prompt queue.
The client rejects `withdraw` as `unsupported-command`. The following outbox
slice will cancel only inputs still pending in the daemon's own durable outbox.
Once claimed/submitted, native withdrawal must remain unsupported or too late;
it must not be reported as a successful cancellation.

## Private daemon transport

`createClaudeDesktopModsServer` builds the private HTTP-over-UDS endpoint. It is
exported for the later runtime Wire slice; it does not start automatically or
advertise new adapter capabilities. Each explicit start creates a fresh private
instance directory and returns its `connectionFile`. The socket and connection
file have mode 0600 and the directory has mode 0700. There is no TCP listener and
no existing Claude credential is used. A separate private binding path keeps
socket cleanup from unlinking a replacement published endpoint.

The `exchange-claude-desktop-mods` pipeline authenticates the pairing token,
validates the v1 frame, and reuses `readClaudeInboxEndpoint` to freshly verify the
unique live Desktop2.1.299 registration on every exchange. CLI, unknown,
ambiguous or conflicting owners fail closed before persistence. The injected
`persist(exchange, ownerPid)` must commit its event/command transaction before
resolving; failures receive no ACK. Returned ACKs and command instances are
validated before they reach the plugin. There is no native `withdraw` command.

The transport owns no transition/replay policy or in-memory command queue.
Durable per-instance event deduplication, owner/sequence reconciliation and
outbox claims belong to the persistence implementation. Shutdown closes clients
and drains pending persistence before removing only the endpoint's own files.
Publishing a stable opt-in connection file across daemon restarts, rereading it
on client transport failure, installing the plugin, and adapter wiring remain
runtime integration work. This Build slice makes no restart-delivery claim.

## Durable event journal

Migration388 adds external Desktop instance checkpoints and an append-only event
journal. External Desktop IDs are not HyperNeo `sessions` IDs; these internal
tables are excluded from agent DB-query scopes. They do not contain or implement
an input queue. The later outbox will reuse `JobQueueRepository`.

`ClaudeDesktopBridgeRepository.persist` commits each contiguous batch and its
checkpoint in one immediate SQLite transaction before returning ACK. Replays
compare canonical event JSON and do not append again. A conflict, gap, owner
change or SQLite failure rolls back the whole batch. New instances must begin
with sequence1 `session.start`; they retire earlier instances atomically. A
retired instance cannot become active again through delayed requests, including
after a daemon restart. Their history remains available for reconciliation.

Lifecycle state starts `unknown`, becomes `busy` on `turn.start`, and becomes
`idle` on the matching `turn.complete`. Completion of a different older turn
cannot clear a newer one. `session.end` records `ended`. Command API receipts
remain separate facts and do not claim that a turn stopped or an input ran.
No command is returned by this Build slice. Durable command claims, retirement
of uncertain submissions, pending-only withdrawal and runtime/adapter wiring
remain subsequent work; missing execution receipts never authorize blind replay.

## Durable command outbox

`ClaudeDesktopOutboxRepository` reuses `JobQueueRepository`, with distinct
per-session input and stop lanes. It registers no generic job processor and
disables automatic retries. An exchange commits journal ACK, scoped command
receipts, retirement of uncertain claims and the next instance-bound claim in
one immediate transaction. A reconnect to the same plugin instance returns the
same command ID; it does not allocate another submission. A new instance, owner
change or reclaimed bound job never authorizes replay of the uncertain effect.

Busy turns retain unclaimed inputs in the daemon. An unknown lifecycle state
requires a separately verified idle-owner fact before a first input is claimed;
the default is false. A known busy state takes precedence over that fact. Stop
has a separate lane and can progress while a submitted prompt waits for idle.
API resolution, rejection and dropped prompts are stored as command facts,
without claiming model execution or actual turn termination.

Withdrawal verifies the external session and original sender, then uses the
existing pending-only job CAS in a transaction. Unclaimed withdrawn inputs stay
withdrawn across restart. Claimed or completed inputs return `not_queued`; a
foreign sender/session, stop command or native Desktop queue ID is unsupported.
Neither lease reclamation nor instance replacement makes an uncertain input
withdrawable again. Runtime opt-in, stable connection publication and adapter
wiring remain separate Wire work; this Build slice advertises no new capability.
