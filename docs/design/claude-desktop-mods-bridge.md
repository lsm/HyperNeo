# Claude Desktop mods bridge

This is the opt-in plugin client Build slice of #7350. The daemon listener,
durable outbox and driver wiring follow separately; installing this slice alone
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
