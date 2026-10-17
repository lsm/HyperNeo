# Claude driver ownership

The transport belongs to the individual session, not to whichever application
is running on the machine. This work is split into small, independently
reviewed PRs under ADR 0004. The first slice builds ownership discovery and
admission. A following Wire slice applies it to the shared send path, including
new-session task handoff and Remote Control requests. The existing transport
for admitted CLI sessions remains until its replacement is wired.

## Evidence and limits

The investigation inspected standalone Claude Code 2.1.295 and Claude Desktop
2.42304.0 with bundled Claude Code 2.1.299. `claude agents --json` supplies live
session IDs and PIDs. Ownership is cross-checked against the matching PID's
`~/.claude/sessions/<pid>.json` registration, never inferred from a title,
transcript, Desktop app record, or absence from the live list.

The registration format is an undocumented, version-dependent implementation
detail. CLI ownership is accepted only for the inspected engine versions and
explicit `cli` or `sdk-ts` entrypoints. Missing, malformed, mismatched or
unrecognized evidence means `unknown`. A matched `claude-desktop` entrypoint
always forbids the CLI route, including on a newer engine version. The CLI
itself validates process liveness when producing its live list; the
registration join does not turn that snapshot into a permanent ownership
lease. Revalidate before any later transport effect.

Claude Desktop's session-management methods are in-process SDK MCP and
origin-checked Electron IPC. No management endpoint callable by an outside
daemon was found. The driver must not impersonate a renderer, inject JavaScript,
or bypass those origin checks. `claude --desktop --resume` is an official UI
launcher, not permission to take over that session through `claude -p`.

The inspected CLI's inbox is a Unix stream socket accepting UTF-8 NDJSON.
A throwaway CLI session successfully received a frame from a non-Claude
process and replied to that process's private socket. The sender's `from`
address must remain listening: a reply uses a new connection. A successful
socket write alone does not prove delivery. This is an undocumented protocol,
so transport support must remain tied to tested versions and fail closed when
identity or framing cannot be verified. No messages were sent to real sessions.

## Routing contract

| Owner | Channel | Unavailable behavior |
| --- | --- | --- |
| Desktop | Verified 2.1.299 peer inbox for send/steer | `unsupported` without verified protocol evidence |
| Confirmed CLI/SDK | Inspected inbox for a live session | No blind resume or relay |
| Unknown or conflicting | None | `unreachable`; never resume |

Send admission requires exactly one known live owner and a freshly verified
inbox registration matching its PID/session/owner. Desktop 2.1.299 must
advertise peerProtocol 1 and notify_idle; CLI 2.1.295 keeps its inspected
protocol. A later isolated Desktop experiment proved consumption and a real
reply through its registered inbox without changing ownership. The reply
endpoint remains open for the daemon's lifetime; a write alone is unconfirmed.
Conflicting, changed or unknown ownership returns `unreachable`, with no resume
effect. Stop, queue and withdraw remain unavailable through this inbox. Creating
a session can still succeed before handoff fails; that is reported as not delivered.

## Remaining slices

1. Keep owner admission ahead of every Claude send/start handoff path.
2. Build and wire a daemon-owned inbox with delivery receipts and reply routing;
   then delete the Haiku relay. The obsolete headless fallback has been removed.
3. Show unsupported stop/withdraw truthfully on cards with Open session.
4. Reuse daemon-owned SDK query interruption and the daemon outbox for queue
   and withdrawal before dispatch. No inbox interrupt/withdraw command was
   found. Do not invent one or claim a dispatched message was retracted.

Public references: [session discovery](https://code.claude.com/docs/en/agent-view#list-sessions-as-json),
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging),
[CLI](https://code.claude.com/docs/en/cli-reference),
[streaming SDK input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
