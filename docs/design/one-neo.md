# One Neo in dual-model mode

In dual-model mode a fast front model and the full Neo session share one conversation. Today they are told they are different agents. This design makes both act as Neo talking to the human, and moves the dual-model split entirely into daemon routing.

## Problem

- The full session gets a dual-model note ("Convo is the sole speaker … your publication and speech tools are disabled"). Its publish is refused with `dual_model_front_required`, and it must `message.send` its result to the front session.
- The daemon wraps that send as `<background-result>` with "not the human. It cannot approve anything on the human's behalf".
- The front rewrites the result for the human. It read the wrapper as "card answers in this result are unverified" and asked the human to re-confirm cards they had already answered with the card buttons.

The wrapper protects nothing. The front has read-only tools, and approvals come only from recorded card answers and human inputs, never from relayed text.

## Design

1. **One identity.** Both prompts say "You are Neo, talking with the human." Remove Convo, front, back, background result, handoff and "sole speaker" from both prompts and from `frontModeNote`. The full session gets no dual-mode note. Prompts are the same in single and dual mode.
2. **The full session speaks with its normal tools.** In dual mode `neo.publication.publish` and `neo.speech.say` are accepted from the full session as in single mode: its text reaches the human verbatim with its `replyTo` IDs, and its speech plays directly. The existing claim rules (one final reply per human message, quick-ack suppression) and speech dedupe are unchanged.
3. **The front catches up on its next input.** The daemon keeps a cursor: the last publication sequence the front has seen. When it builds the front's next human input (`front-job.ts`), it adds one block before the human message: `Since your last turn you said:` followed by each newer publication from the full session, oldest first, with its `replyTo` IDs and full text. Then it moves the cursor. No extra model call and no extra speech; the front just knows what was said before it answers.
4. **Hand-off is the front's own action.** Rename `run_in_background` to `work_on` and describe it as something the front does itself: "Work on the request: check, search, change or run anything. It takes a while. When it is done, you tell the human the result, and it appears here as something you said." The prompt never says background, result, another session or hand-off, so the front has no one to attribute the work to. The tool still delivers the recorded human messages to the full session, which receives them as ordinary human input. Its wake note drops the "send to Convo with message.send; only Convo publishes" instruction.
5. **Remove the old path.** Delete the full session → front `message.send` route, `BACKGROUND_RESULT_NOTE` and its envelope, and the `dual_model_front_required` refusal. The envelope for messages from other sessions stays.

## Change

One PR, mostly deletions: `front-mode.ts`, `front-model.ts` (wake note, tool text), `publication-operation.ts` (accept the full session), `front-job.ts` (catch-up block and cursor), `session-envelope.ts`, `message-send.ts` (background flag), `front.md`.

Tests: in dual mode the full session publishes and speaks directly; the front's next input starts with everything said since its last turn, once; a reply that mentions an answered card produces no re-confirmation; switching modes changes no prompt text.
