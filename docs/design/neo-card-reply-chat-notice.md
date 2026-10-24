# Card replies must be visible in chat

When the human quoted the #8442 sign-off card, Neo replied with a new choice
card, but the main chat showed nothing. The human had to check Your Work.

**Decision:** the daemon automatically records a short, linked chat notice when
Neo answers through a card. Neo must not need a second publish call.

- Emit after a successful `neo.question.ask` responding to a human chat input,
  including a new question, `replaces`, or an in-place rewording. Also emit when
  Neo materially updates/replaces the card that input quoted. Exclude unrelated
  background changes, rejected writes, and the human's own answer/state changes.
- Correlate using validated question `replyTo` human message IDs and the stored
  intake quote (`replyTo {kind,id}`). If Neo omits IDs, use the daemon's recorded
  consumed input for that operation and its quote; never guess from timing or
  the latest message. Carry that association through replacements.
- Show one localized Neo row: **“我给你回了 · 查看卡片”** / **“I replied · View card”**,
  with a short question title. Tapping opens Your Work, expands the owning card,
  and scrolls/highlights the question **with its options and answer controls**.
  Resolve `replacedBy` to the current question; show an explicit unavailable
  state if removed. Keep the chat position for returning.
- Persist the card mutation and notice atomically. Use an ordinary publication
  with typed `cardReply` metadata (source human IDs, ask/question target, durable
  mutation ID); existing publication paging/live refresh supplies the timeline.
  Deduplicate by conversation + mutation ID across retries/reconnects. Coalesce
  subsequent revisions of the same reply into that row, retargeting replacements;
  distinct later human replies get their own row. A manual publication carrying
  the same typed association updates that row rather than adding another.
  Do not copy the question/options into chat or mark a human input “answered”
  merely because Neo asked a follow-up question.

**Code grounding / later implementation:** `packages/daemon/src/lib/neo/`
`intake.ts` stores quotes; `question-operations.ts` writes questions without a
publication; `operations.ts` wires both services. Change these plus
`storage/repositories/neo-ask-todo-repository.ts` and
`neo-publication-repository.ts` (under `packages/daemon/src/`) for atomic,
idempotent notices. Extend `packages/shared/src/types/neo-publication.ts` and
`lib/neo/publication.ts` in the daemon for the typed target. In
`packages/web/src/neo/`, change `public-conversation.ts`,
`NeoPublicConversation.tsx`, and `NeoLive.tsx`; reuse `NeoAskTodos.tsx` question
anchors and the existing `onOpenWork` path.

**iOS is required:** in `lsm/neo-ios`, extend `Neo/Models/Models.swift` and
`Neo/API/NeoAPI.swift` to retain the metadata, then `Neo/Views/MessageView.swift`,
`HomeView.swift`, and `WorkSheetView.swift` to open/focus the question using the
existing card-link route. Web changes alone do not fix the native chat.

**Acceptance for implementation:** reproduce #8442 on web and iOS; a new choice
or updated/replaced quoted card produces one tappable row and reveals its
options. Retry, reconnect, and reload preserve one row; unrelated mutations
produce none. This PR changes only this design; runtime behavior is unverified.
