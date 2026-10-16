# Claude CLI inbox transport

This ADR 0004 Build slice is not wired into a driver. It implements the Unix
NDJSON protocol inspected in Claude Code 2.1.295 and exercised against an
isolated throwaway CLI session during the approved investigation. Other
versions are rejected. It is an undocumented protocol and may change.

`openClaudeInbox` is scoped to one already-resolved target. Before calling it,
the driver must prove current CLI ownership, match the live PID/session to its
registration and obtain its registered socket path. Neither this low-level
transport nor the existence of a socket grants permission to use CLI for a
Desktop-owned or unknown session. Revalidate ownership before each send.

The transport checks the target filename against its PID and requires a
private same-user directory and socket. It never borrows a Claude auth token
or uses private Bun peer-credential APIs. Public `node:net` does not provide
the peer-PID check used internally by Claude. Filesystem ownership and the
random reply address are local transport checks, not proof that a reply came
from a human. Keep the reply's peer provenance when routing it into the daemon.

The daemon binds a private reply socket in the target inbox directory and
keeps it listening after sending. Claude replies on a new connection. Caller
provided message/input UUIDs are stable retry identities; repeated identical
submissions on the same live inbox share one write result, and changed content
under the same identity is rejected. A failure before attempting a socket write
can retry with the same frame. Once a write was attempted, a failure is uncertain
and remains cached to prevent blind duplicate delivery.
This cache is not durable across daemon
restarts. Closing cancels pending transport effects and releases the inbox.

`write` returns only `{ written: true }`. It makes no delivery, queue or model
consumption claim. Correlated peer receipts are separate events, as are replies
from the target address. A peer text reply is scoped to the target conversation,
not assumed to answer one particular input. Driver integration must handle
receipt timeouts/unknown outcomes without blindly retrying, persist replies as
peer messages, and own inbox lifetime/shutdown. Do not close immediately after
write and thereby strand replies like the old one-shot relay.

Only priority `next` is emitted: an idle CLI wakes, and a busy CLI receives it
at its next tool round. The CLI's own inbound gate can still hold or refuse it.
There is no socket interrupt or withdrawal command. The inspected `later`
behavior does not guarantee a queue-until-turn-end contract across held
messages, so queue/withdraw for daemon-owned SDK sessions must use the daemon
outbox and supported SDK interruption instead.
