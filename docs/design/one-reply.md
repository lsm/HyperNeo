# One reply per message

In dual-model mode the human often gets the same answer twice. The front acknowledges, then answers itself seconds later, or the full session repeats what the front's acknowledgment already said. This design gives the front one reply per human message and tells the full session what the front already said. It also gives the full session the same text-and-details shape.

## Problem

- The front must acknowledge every input before anything else (`front.md` line 8, `front-job.ts:74`, `front-mode.ts:21`), and code enforces it: a final reply without an acknowledgment is refused with `front_ack_required` (`front-model.ts:48-56`). When the front can answer from its reads, the human gets "I'll check" and then the answer about a second later.
- The acknowledgment has no length limit (`reply_short` `text` takes 16000 characters), so the front often writes the whole plan into it.
- `work_on` passes only human message IDs (`front-model.ts:101-102`). The full session receives the human's words and the quoted card (`neoIntakeMessage`, `front-model.ts:125`), but not the acknowledgment, so its answer repeats it. The other direction already works: the front sees the full session's replies in `<already-said>` (`front-catch-up.ts`).
- Acknowledging and handing off are two separate calls, so the front can do one without the other, for example acknowledge and never hand off or answer.
- The front has two reply tools that differ in one field (`reply_short`: `text`; `reply_detailed`: `summary` and `details`).
- The full session's `shortText` is described as the summary and `fullText` as "the details of the topic(s) shortText names" (`publication.ts:29-38`). So `fullText` is used as an addition, and in practice the full session's `shortText` is longer than its `fullText` in about half of its replies.

## Design

1. **One front reply tool.** `reply_short` and `reply_detailed` become one `reply` with `text` (required), `details` (optional) and `work_on` (optional `true`), plus the existing `replyTo`, `spoken`, `links`, `artifacts` and `session`. The front calls it once per human message:
   - Without `work_on`, it is the answer. No acknowledgment comes first, and the `front_ack_required` check is removed.
   - With `work_on: true`, it is a one-sentence acknowledgment (`text` at most 200 characters, no `details`) and the hand-off in one call. The daemon publishes it as progress under the same `frontProgressId`, then reserves the inputs for the full session as `work_on` does today. The separate `work_on` tool and its acknowledgment check are removed; this replaces the separate hand-off tool of `one-neo.md` point 4.
2. **The hand-off carries what the front said.** When the daemon builds the full session's message for a handed-off input, it reads the front's publications that answer that input (the progress reply is found by `frontProgressId`) and appends them in the same `<already-said>` block the front reads. The root prompt says once: `<already-said>` is what the human has already been told; do not repeat it, and say only what is new or the result.
3. **The full session uses the same shape.** `neo.publication.publish` takes `text` and optional `details` instead of `shortText`, `fullText` and `verbatim`. The stored publication does not change, so clients and internal producers do not change: without `details`, `text` is stored as `fullText` with `verbatim`; with `details`, `text` is `shortText` and `details` is `fullText`.
4. **Short details fold in.** For both tools, when `details` is shorter than `text`, the daemon appends it to `text` and stores one verbatim field, so a reply never shows a summary longer than its Details.

## Not changed

Stored publications and their client rendering, input ownership and `input_handed_off`, the front's read tools, the front's catch-up from the full session, and single-model mode.

## Change

- PR 1: points 1 and 2 (`front-model.ts`, `front-session.ts` (its tool allowlist), `front-job.ts`, `front-mode.ts`, `publication-operation.ts` for progress, `shared/src/types/neo-refusals.ts` (the `front_ack_required` and `work_on` texts), the verify scripts `neo-front-execution.ts` and `neo-two-speakers.ts`, `front.md`, `root.md`, and the front tool names filled into the shared turn-end prompt in `prompts/src/mod.ts`). Tests: a reply without `work_on` publishes as final with no earlier acknowledgment; a reply with `work_on` publishes progress and reserves the input in one call; `work_on` with `details` or a long `text` is refused; the full session's hand-off message carries the acknowledgment in `<already-said>`.
- PR 2: points 3 and 4 (`publication-operation.ts`, `publication.ts` input, `neo.publication.publish.md`, `root-turn-end.md` (its shortText, fullText and verbatim guidance), `front-model.ts` for the fold). Tests: `text` alone is stored verbatim; `text` with longer `details` is stored as summary and details; shorter `details` fold into one verbatim field; old `shortText`/`fullText` input is refused.
