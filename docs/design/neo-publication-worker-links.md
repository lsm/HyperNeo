# Server-derived worker links on Neo publications

Status: proposal. Design only; no application code in this PR.

## Decision

A publication's worker is a fact derived by the daemon, not a model assertion.
Remove `session` from the model-facing `neo.publication.publish` draft and prompt.
Keep stored `NeoPublication.session` and presented `sessionSource` for clients and
history; old publications need no migration.

Derive the value once in the existing `neo.publication.deliver` pipeline before append.
An idempotent retry keeps the stored value. A new revision derives from its own turn.

## Reliable signals

Build one candidate set from the publication's direct, persisted provenance:

- Current message IDs select `neo_session_messages` rows delivered to the publisher;
  ordinary session messages contribute `fromSession` for the causing report/question/status.
- `cardReply.questionId` selects the question's recorded answer-route worker and
  todo assignment, both recorded by delivery rather than names in text.
- A human input named by `replyTo` contributes no worker itself. If its recorded
  reply target is a question, use that question's answer-route/todo worker as above.

Canonicalize `(adapter, id, daemon)` and union candidates; no priority or fallback order.
Exactly one distinct worker stores the existing session reference. Zero, multiple,
conflicting, or unavailable candidates store no session and do not reject publication.

Only workers qualify. Exclude the publisher, root/front Neo and every Neo-bound session.
Never use `NeoAsk.sessionId` or the operation caller: those identify coordinating Neo.
Do not scan active todos, match text, infer from a repository, or choose by recency.

`presentNeoPublications` resolves the stored ref through the existing session-open-source
path. A null or unsafe `sessionSource.link` renders no button; never substitute Neo.

## Clients

All clients consume only the presented `sessionSource`; none derives a worker itself.

- Web keeps the Open session action in the publication header beside Neo and the
  timestamp. Use the returned source directly rather than issuing a second lookup.
- Desktop keeps that same web placement. Its existing native-link handoff opens
  Claude/Codex links in the owning app; local worker links open the worker session.
- Phone places the same icon/action in the publication bubble header. It passes the
  returned Claude/Codex or remote link to the platform opener, and opens local worker
  links in the worker conversation. No resolved link means no action.

The action uses the exact resolved link, never a route built from the publication's
conversation ID, ask owner, or Neo session ID.

## Rejected alternative

Choosing the most recently active worker under absent or ambiguous provenance adds
buttons, but a plausible wrong conversation is worse than no button.

## Acceptance

Cover one sender, mixed human/worker input, two workers, none, Neo senders, card ownership,
retries and revisions. Clients prove exact-link opening and no button without provenance.
