# Model worker plus server fill-in on Neo publications

Status: proposal. Design only; no application code in this PR.

## Decision

Keep the model-facing `session` field in `NeoPublicationDraft`, the publish prompt and
`front-model.ts` `replyFields`. An explicit non-Neo worker remains authoritative; server
derivation only fills an absent field. Web behavior and the stored contract stay unchanged.

Only `session === undefined` triggers prior-session retention or derivation. Make the
draft non-nullable: explicit `null` fails admission instead of counting as omitted.

This preserves the common case where Neo answers a human about a known worker: the
input has no worker sender, but the model can name that worker directly.

## Existing server behavior to keep

Refuse an explicit `neo:` session as `unknown_session` before retention or derivation;
this is the chosen rule, not silent stripping. For an explicit non-Neo worker,
`neo.publication.deliver` resolves the exact session and accepts only `found`. An unknown
session rejects publication; a lookup failure asks for a retry with the same requestId
and session. Front publications keep this same explicit path.

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

`workerSession` filters Neo-prefixed senders only on the derived path; explicit values
follow the refusal above. Presentation and session-open-source resolution stay unchanged.

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

Test explicit valid/unknown/unavailable workers, `neo:` and `null` refusals without
retention or derivation, derived single/missing/mixed senders, prior retries/revisions,
and front's explicit field. Web stays unchanged. iOS verifies its own user-visible flow.
