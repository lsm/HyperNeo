# Model worker plus server fill-in on Neo publications

Status: proposal. Design only; no application code in this PR.

## Decision

Keep the model-facing `session` field in `NeoPublicationDraft`, the publish prompt and
`front-model.ts` `replyFields`. An explicit worker remains authoritative; the daemon's
existing derivation only fills an omitted field. No daemon or web contract changes.

This preserves the common case where Neo answers a human about a known worker: the
input has no worker sender, but the model can name that worker directly.

## Existing server behavior to keep

For an explicit worker, `neo.publication.deliver` resolves the exact session and accepts
only `found`. An unknown session rejects publication; a lookup failure asks for a retry
with the same requestId and session. Front publications keep this same explicit path.

When the model omits `session`, keep `sourceSession` as the only fill-in. Every current
processing-state input ID must select a `neo_session_messages` row delivered to the
publisher, and every row must have the same non-batch `fromSession`. Only then does
`workerSession` fill the field; a derived session that cannot be resolved is omitted.

No inputs, a missing row, human input, worker batch or different senders means no
derived session. Never discard unresolved inputs or infer from text, recency, questions,
todo assignments, repositories or `NeoAsk.sessionId`. An explicit valid worker still
attaches in these cases because it needs no inference.

If a prior publication exists for the requestId and the model omits `session`, keep the
prior session before attempting derivation. A new explicit worker is validated normally.

`workerSession` continues to exclude Neo-prefixed session IDs. Presentation keeps the
stored session and existing session-open-source resolution; no new provenance is stored.

## Clients

- Web keeps `NeoPublicationSession` beside Neo and the timestamp. It resolves the stored
  session through `neo.session.link`; no publication parser or disabled-action changes.
- Desktop keeps that same web surface and existing native-link handoff. Local worker
  links continue to open the worker session, never Neo's own conversation.
- iOS is a separate client follow-up PR. That PR owns button placement, opening behavior
  and device verification; this design claims no current iOS `sessionSource` support.

## Rejected alternative

Server-only inference would remove the explicit field and lose the worker precisely
when Neo answers a human about that worker. The two existing paths are complementary.

## Acceptance

Keep tests for explicit valid, unknown and unavailable workers; derived single, missing
and mixed senders; prior-session retries and revisions; and front's explicit field.
Web behavior remains unchanged. The iOS follow-up must verify its own user-visible flow.
