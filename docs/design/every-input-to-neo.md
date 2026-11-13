# Every human input reaches Neo

In dual-model mode the fast model replies first, then decides whether the full Neo session sees the message at all. When it decides wrong, the message stops there. This design sends every human input to the full session, together with the reply the human already got, and lets the full session decide what, if anything, to add.

## Problem

- **Inputs the fast model answers never reach the full session.** `reply` without `work_on` (`front-model.ts`) publishes and ends; only `work_on` hands off. In one day, 16 of 85 human inputs ended at the fast model. They included standing instructions (who reviews which PRs, which worker gets which kind of work); the fast model replied "I will follow this from now on", but the full session never received them and nothing was saved. One was an approval the fast model misread as a request for changes; the human had to repeat it.
- **The fast model invents answers it cannot check.** Asked who added a feature, it replied "I added it, my mistake" with no read, and added a detail nobody had decided. Its reads cannot answer history questions, and nothing downstream sees the reply to correct it.
- **The human hears the same acknowledgment twice.** The fast model acknowledges, then the full session speaks its own acknowledgment through `neo.speech.say` before the work. The rule comes from `speech.md`, included in the full session's system prompt by `root-turn-end.md`: while listening, "before starting time-consuming work, use neo.speech.say to briefly acknowledge the request". In single mode that rule is also sent per input (`NEO_QUICK_ACK_LISTENING`, added by `listeningInput` in `speech.ts`), so the system-prompt copy only matters in dual mode, where it duplicates the reply already given.

## Design

1. **Every reply hands off.** The fast model's `reply` always publishes and then reserves the input for the full session in the same call, as `work_on` does today. `work_on` is removed from the tool. The reply is either the answer or one brief line saying what will be done, never claiming it is done; its other limits are unchanged. With several `replyTo` IDs, each input is handed off with the same reply.
2. **The hand-off carries what the human got.** `handOff` builds `<already-said>` from the reply just published (its `fullText`), not from a lookup of the derived progress ID, so an answer and an acknowledgment are carried the same way. Nothing in it says who wrote it.
3. **The full session decides.** `root.md` replaces "Never repeat `<already-said>`" with one sentence: "`<already-said>` is what the human has already received for this message. Do not repeat it. If it is wrong or incomplete, correct it at once; otherwise do the work, and reply only with what is new." No mention of other models, lanes or sessions.
4. **No second acknowledgment.** Remove the acknowledgment exception from `speech.md` (the sentences from "the silent-work rule has a conversational exception" to "Simple questions can go straight to the answer"). Single mode keeps its per-input `NEO_QUICK_ACK` / `NEO_QUICK_ACK_LISTENING` note, so its behavior is unchanged. Dual-mode hand-offs carry no such note, so the full session no longer acknowledges what the human already heard.
5. **Fast-model prompt.** `front.md` drops the `work_on` paragraph and the "When you can answer from your reads" split: "Call reply once for each human input. If your reads answer it, reply with the answer; otherwise say in one brief line what will be done, without claiming it is done. Every message also goes on to be handled in full, so never promise what you cannot check." The `reply` tool description drops `work_on`.

## Not changed

- Ownership and settlement: `reserve` already sets `owner = 'neo'` and `claim` no longer refuses the other lane, so the full session can publish for an input the fast model answered. A failed reply still falls back as today (`front-outcome.ts`).
- The fast model's own catch-up (`<already-said>` built in `front-job.ts`).
- Single mode.

## Change

One PR: `front-model.ts` (always hand off, `work_on` removed, block from the published reply), `front.md`, `root.md`, `speech.md`, and the verify journey `neo-two-speakers`. Tests: a reply that answers hands the input to the full session with that answer in `<already-said>`; a reply with two `replyTo` IDs hands off both; the full session's prompt has no acknowledgment rule in dual mode and keeps the per-input note in single mode; a later full-session reply for an input the fast model answered is accepted.
