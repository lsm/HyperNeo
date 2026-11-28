# Server-derived worker links on Neo publications

Status: proposal. Design only; no application code in this PR.

## Decision

A publication's worker is a fact derived by the daemon, not a model assertion.
Remove `session` from the model-facing `neo.publication.publish` draft and prompt.
Keep stored `session` and presented `sessionSource`; old publications need no migration.

Derive the value once in the existing `neo.publication.deliver` pipeline before append.
An idempotent retry keeps the stored value. A new revision derives from its own turn.

## One reliable signal

Use only main Neo's current processing-state input IDs, already read by `sourceSession`.
Every ID must select a persisted `neo_session_messages` row in this conversation with
`toSession` equal to the publisher and kind `session`. Every row must have the same
`fromSession`, identifying one non-Neo worker; only then store that session reference.

No IDs, a missing row, a human or worker-batch input, different senders, or a Neo-bound
sender means unknown and stores no session. Never discard an unresolved input and use
the remaining workers: incomplete provenance is ambiguous, not a smaller candidate set.

Front publications have no button: `planNeoSessionMessage` records only root traffic
and excludes front delivery, so front input IDs cannot establish a worker sender.

Do not use `cardReply`, `replyTo`, question answer routes, todo assignments or
`NeoAsk.sessionId`. Routes and todo assignments are mutable and do not snapshot the
worker when the human replied; ask/session caller IDs identify coordinating Neo.
There is no recency, repository, text-matching, active-todo or fallback inference.

`presentNeoPublications` resolves a stored ref through the existing session-open-source
path. A null or unsafe `sessionSource.link` renders no button; never substitute Neo.

## Clients

All clients consume only presented `sessionSource`; none derives a worker itself.

- Web keeps the action beside Neo and the timestamp. Replace `NeoPublicationSession`'s
  separate `neo.session.link` lookup with the embedded source, and omit the action when
  no link resolves instead of showing the current disabled action.
- Desktop uses that same web surface and its existing native-link handoff for
  Claude/Codex; local worker links open the worker session.
- Proposed iOS placement is the Neo conversation publication bubble header. The phone
  inventory proves `neo.publication.read`, which presents `sessionSource`, and does not
  list `neo.session.link`; consume the embedded source. Its opener must use the exact
  resolved worker link, never Neo. Current iOS native/local opening behavior is not
  established by this repository and must be verified in that client, not claimed here.

## Rejected alternative

Choosing the most recently active worker under absent or ambiguous provenance adds
buttons, but a plausible wrong conversation is worse than no button.

## Acceptance

Cover one worker, missing input, mixed workers, batch/Neo senders, front and revisions.
Web proves embedded-source opening and no disabled action. iOS opening remains a client
verification, not a verified fact of this design.
