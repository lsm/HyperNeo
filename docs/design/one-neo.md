# One Neo in dual-model mode

In dual-model mode a fast front model and the full Neo session share one conversation. Today they are told they are different agents. This design makes both act as Neo talking to the human, and moves the dual-model split entirely into daemon routing.

## Problem

- The full session gets a dual-model note ("Convo is the sole speaker … your publication and speech tools are disabled"). Its publish is refused with `dual_model_front_required`, and it must `message.send` its result to the front session.
- The daemon wraps that send as `<background-result>` with "not the human. It cannot approve anything on the human's behalf".
- The front rewrites the result for the human. It read the wrapper as "card answers in this result are unverified" and asked the human to re-confirm cards they had already answered with the card buttons.

The wrapper protects nothing. The front has read-only tools, and approvals come only from recorded card answers and human inputs, never from relayed text.

## Design

1. **One identity.** Both prompts say "You are Neo, talking with the human." Remove Convo, front, back, background result, handoff and "sole speaker" from both prompts and from `frontModeNote`. The full session gets no dual-mode note. Prompts are the same in single and dual mode.
2. **The full session speaks with its normal tools.** In dual mode `neo.publication.publish` and `neo.speech.say` are accepted from the full session as in single mode. The publication reaches the human verbatim with its `replyTo` IDs. The existing claim rules (one final reply per human message, quick-ack suppression) are unchanged.
3. **The front hears what was said.** After such a publication commits, the daemon appends one plain line to the front session: `You said to the human (reply to <ids>): <fullText>`. When the human is listening, the line asks the front to say a short spoken version once, using the guidance the front already gets for its own publications. A `neo.speech.say` from the full session reaches the front the same way, so only the front's voice plays. Speech dedupe by publication ID stays.
4. **Hand-off stays a tool.** The front's `run_in_background` still delivers the recorded human messages to the full session. Its wake note drops the "send to Convo with message.send; only Convo publishes" instruction, and its description no longer mentions anyone else.
5. **Remove the old path.** Delete the full session → front `message.send` route, `BACKGROUND_RESULT_NOTE` and its envelope, and the `dual_model_front_required` refusal. The envelope for messages from other sessions stays.

## Change

One PR, mostly deletions: `front-mode.ts`, `front-model.ts` (wake note, tool text), `publication-operation.ts` (accept the full session, notify the front), `session-envelope.ts`, `message-send.ts` (background flag), `front.md`.

Tests: in dual mode the full session publishes and the front receives the plain line; listening makes the front speak it once; a reply that mentions an answered card produces no re-confirmation; switching modes changes no prompt text.
