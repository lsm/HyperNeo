# Neo: the daemon owns state, the model writes words

Status: proposal, revised after the 2026-10-12 transcript audit. Tracks: epic #6002.

## Why

On 2026-10-12 the human sent Neo 25 messages. Root Neo ran 169 turns, published 415 messages, and its context was compacted 28 times. 122 of those turns started from a "work you handed off went idle" note.

An audit of 12:30–15:14Z (root Neo plus the topic session `fe8c48f2`) found:

- 11 turns ended at max_turns;
- about 200 full snapshot reads of 12–55 KB each;
- about 150 publish attempts, roughly 60 of them refused;
- 7 compactions;
- about 30 "no visible output" nudges.

The same failures kept coming back, each with its own patch (#6592 cites, #6639 keyword checks, #6646 item kinds, #6609 reply cap). Every patch closed one path, and Neo found another.

The audit traced them to six causes, none of which is the model's wording:

1. **Inputs aren't typed or consumed once.** Daemon notes, runtime nudges, token notices and compaction prompts reach Neo as user messages, and Neo answers them.
   - The runtime nudges "no visible output" after Neo has already published through a tool. `reply_limit` then says "end the turn now", the nudge fires again, and the loop runs until max_turns.
   - `error_max_turns` is retryable (`message-delivery.ts`), so the same input runs again with a fresh reply allowance.
   - A human message that arrives mid-turn is streamed in, then dispatched again later, out of order. The duplicate ask da9506d1 came from this.
2. **Progress is counted in continue calls, not in work.**
   - A worker's PR (#6651) never reached `card.prs`.
   - The idle note says "never wait on a PR that prs doesn't list; continue now", so every "waiting on CI" idle became a continue: 20 on one card.
   - The stall counter then reported "ask the human", and Neo wrote the "approve again" gate.
   - The same counter marked the slice-1 card stalled after the human's own correction.
3. **Neo can't read the facts it is told to check.**
   - `tick` refuses "reported" with "you can read this PR yourself", but no PR or issue read op exists.
   - Neo can't read the repo; WebFetch rewrote the design doc.
   - So items are ticked from prose. One was ticked "met" with evidence saying "pending", and the daemon accepted it.
4. **Human-only actions block management, not risk.**
   - `neo.work.close` and adopt are refused even when the human told Neo in chat to do exactly that. Neo then turns each refusal into a gate for the human.
   - A raw `work.send` to the same untracked session succeeds, so the rule adds no safety.
5. **Asks have no integrity rules.**
   - Neo removed the original deploy items to settle "achieved".
   - An ask opened in a system turn starts unapproved, which creates a Start gate inside approved work.
   - There is no withdraw or fold. Overlapping asks drift apart.
6. **Decisions travel as paraphrase.** The human said a human-only step becomes a question about the result, "did it work?" *or* "are you satisfied?". After two relays it reached the worker as two fixed questions that must both be Yes.

Underneath all six: **human-facing state is authored by the model in prose, and the daemon then tries to validate the prose.** The fix is to have the daemon own every fact and every rule, and ask the model only for words.

## Principles

1. **Every input has a kind and is consumed once.** Human, daemon note and runtime are distinct kinds. Each input starts at most one turn and is never replayed.
2. **What the human must do is derived, not written.** The daemon computes every human action from facts. The model can't create a gate in prose.
3. **When to tell the human is derived, not judged.** The daemon decides that something worth saying happened. The model writes the sentence only then.
4. **Facts come from the daemon.** PR, issue, deploy and card state are read and tracked by the daemon. The model reads them through cheap, scoped views, never from memory or a worker's word.
5. **Progress is measured on the work.** A stall means the worker made no progress, not that Neo called continue a few times.
6. **Neo manages work; the human decides outcomes.**
   - Neo can open, route, continue, close and fold the work it manages.
   - The human approves asks and answers questions, including about what only they can see.
   - The session that worked on a PR merges it.
7. **Decisions travel verbatim.** A relayed decision quotes the human and cites its canonical record.

## Design

### 1. Inputs and turns

- Every input carries `kind`: `human`, `note` (daemon), or `runtime`. Runtime text (nudges, token notices, compaction prompts) is never shown to Neo as a message. Publication and cite checks accept only `human` input as the human's words.
- Each input is consumed exactly once. An input streamed into a running turn is marked consumed and is not dispatched again. An older human message is never delivered after a newer one that was already handled.
- A Neo turn may end without final text. A turn with an accepted publication, or one that ended after a refusal saying nothing more is needed, is complete. The "no visible output" nudge (from the agent runtime, not the daemon) is turned off for Neo sessions.
- A refusal that says "stop" (`reply_limit`, `repeated_reply`) ends the query.
- `error_max_turns` and API errors (502/529) are recorded as failed, not success, and are not blindly re-run. The daemon re-wakes Neo once from current state, with the publications already accepted for that input listed, so nothing is said twice.
- The input-to-ask origin binding is persisted, so a daemon restart doesn't lose it (`unknown_ask_origin`).

### 2. Facts the daemon tracks

- An ask item can name what it depends on: `watch: [pr|issue url]`. The daemon tracks those from the GitHub events it already receives and ticks the item met on merge or close, with the event as evidence.
- A card's PRs are attached by the daemon: from the worker session's branch or PR author, or a PR the report names, after reading it. `card.prs` is never empty while the worker has a PR open.
- A card whose doneWhen the daemon can read (its PRs merged, its issue closed) is settled by the daemon without a Neo turn.
- Neo gets read-only views of a PR (state, checks, review verdict on head) and an issue. It never needs a worker's word for something the daemon can read.
- A deploy item is met when the daemon reads back that each daemon runs a commit containing the change.
- A model `met` tick is accepted only for items the daemon can't read. For items the daemon owns, the daemon ticks.

### 3. Progress, continues and stalls

- **Progress** is anything that changes the work: a new commit on the card's PR, a PR state or verdict change, a report that differs from the last one, or an item ticked.
- **A stall** is three wakes in a row for a card with no progress. Continue calls don't count. A continue that carries new human input resets the count.
- `neo.work.continue` is refused, with the reason, when:
  - the card's doneWhen is met;
  - a card PR is waiting on CI or review (the daemon wakes Neo when its verdict changes);
  - the card was already continued in this wake.
- **A hand-off that failed before delivery** (not delivered, CLI logged out and the like) under an approved ask is retried by the daemon, up to three times (30 s, 2 min, 10 min), without waking Neo. Only after the last attempt fails does the card show `retry`, and Neo is told once. Delivery failures are infrastructure, not a decision for the human.
- A continue stays within the card's goal. New scope becomes a new card, deduped by issue or PR key.
- A card's report is the working session's reply to the card's own message, capped at about 1.5K, and never includes the human's input. When a card targets a session the human also uses, only turns that the card's message started count as the card's idle or report.

### 4. Derived human actions

Each ask view lists `humanActions`, computed by the daemon on every snapshot. They are the only things a client shows as buttons:

| Action | Derived from |
|---|---|
| `start {workId}` | a card under the ask is `proposed` and the ask isn't approved |
| `approve` | the ask's approval expired (48 h), or a card stalled per §3 |
| `answer {itemId, options}` | a question Neo asked (below); the buttons are that question's options |
| `retry {workId}` | existing card rules (`retryable`) |
| `talk {workId, what}` | the card's session refused what it was asked, or said it needs the human to tell it directly (below) |

`talk` is for a session that won't do what the card asks until the human tells it directly. The card says so in one plain line, naming the session and what it refused, and points at the card's own Open button: "daemon-code won't update the iMac on Neo's request. Open it and tell it yourself." Neo sets it with `neo.work.refused {workId, what}` after reading the report, and doesn't relay, repeat or argue with the session. The daemon clears it when that session next gets input from the human, and Neo is woken with the card's next report.

The model has exactly one way to ask the human something: `neo.ask.question {askId, question, options[2..4]}`. It is one question about one result, worded for that step, and answered with one tap. A human-only step such as a manual test becomes a question: "Did the keyboard hide?" → Yes / No. The item is met on the positive option; otherwise it stays open and Neo is woken. Neo can withdraw its own question with a reason. A claim only the human can check (on a device, or on a machine the daemon can't read) is a question too, so there's no separate Confirm button: the buttons always come from the question.

Removed:

- `needs_you` as a tick state, and its cite, kind and regex checks;
- `waiting`/`blocked` settles that carry a free-text gate. An ask is waiting exactly when `humanActions` is non-empty, and blocked when a card failed with no retry left;
- "Done" and "Confirm" on items.

### 5. Ask integrity

- One request becomes one ask. When a duplicate slips through, `neo.ask.fold {from, into}` moves its items and cards and closes it as superseded.
- An ask opened while Neo works on an approved ask inherits that approval. It never creates a Start gate inside approved work.
- An item from the human's request can't be removed by Neo. Dropping one is a `neo.ask.question` to the human.
- An item can point at a sub-ask, and its state follows that ask's status, so overlapping asks can't drift.
- A card belongs to the ask it was opened for, not to whatever input triggered the turn.

### 6. Who may do what

- **Neo-managed** (any turn, recorded with a reason on the card):
  - propose, start under an approved ask, continue, close and fold work it opened;
  - follow a session the human named. The Track button and its one-hour adopt rule are removed.
- **Human** (from a client button, or from a live turn whose input is the human's message naming the target, using the one shared check `work.start` and `ask.approve` already use):
  - approve an ask;
  - answer a question;
  - cancel a concern.
- Human authority is the live human message, whichever Neo session receives it: in that turn root or a topic avatar may also continue or retry a card another Neo session proposed.
- A refusal never tells Neo to ask the human for something a live human message already covers.

### 7. Notifications

A publication to the human happens in three cases only:

| Trigger (daemon-detected) | What Neo writes |
|---|---|
| the human sent a message | one reply to it |
| an ask reaches achieved, or every item is met | one sentence naming the outcome |
| an ask gains a `humanAction`, or a card fails with no retry | one sentence naming what's needed or what broke |

- The daemon refuses every other `neo.publication.publish`, with a reason. Interim "I'm checking…" posts go away.
- For each trigger, the daemon wakes Neo with a note naming the trigger. The publication carries the trigger's id, so it can't be repeated for the same transition.
- A publication is written in the language of the human's last message.

### 8. Wakes and tools

- Routine progress doesn't wake Neo: a PR waiting on CI or review, a check passing, a review starting, or news about an item already met.
- Neo wakes for:
  - a card report that needs judgement;
  - a failure;
  - a stall;
  - a human input;
  - a notification trigger.
- A wake's writes are limited to the ask that woke it.
- Each wake note carries the ask's derived state (items, humanActions, cards with PR verdicts) and no instructions that contradict each other. The system prompt says this state overrides anything remembered.
- `neo.snapshot` defaults to the waking ask and returns "unchanged since rev N" when nothing changed. Every mutating neo op returns the updated ask view.
- The core neo ops' schemas are available without `operations.describe`.
- `work.find`:
  - escapes FTS input (hyphens and underscores fail today);
  - caps its output;
  - looks up by id.
- One session ref form is accepted everywhere a target is.
- Optional arrays default to empty, and the id field names are consistent.

### 9. Decisions and relays

- A relayed decision quotes the human verbatim and cites its canonical record: an issue comment, or a doc path at a commit.
- It reaches a worker as an amendment to the card's instruction through `neo.work.continue`, recorded on the card, never as a raw `work.send`.

### 10. Ownership

- Work goes through Neo asks. Peer sessions get work as cards.
- The session that worked on a PR merges it. For a PR approved on its head, CLEAN, with no unresolved threads, for over 30 minutes, the daemon wakes that session to merge it rather than merging it itself. A PR that still doesn't merge is an exception to find and fix in the system. `ship.sh` retires.
- Per-topic sessions (#6579, #6604) hold their asks, and root Neo keeps cross-topic questions only. A topic session is short-lived and starts from a snapshot.

## Slices

Each slice is one PR, behaviour-tested, and deployable on its own. The order follows the dependencies:

| # | Slice | Sections | Depends on |
|---|---|---|---|
| 0a | Typed inputs, consume once, no nudge for Neo, stop on refusal, failed turns recorded as failed, persisted origin | §1 | none |
| 0b | PRs attached to cards, progress-based stall, continue refusals, card report scoping; decisions reach workers as continue amendments that quote the human and cite the record | §3, §2 (card PRs), §9 | none |
| 0c | Daemon retries hand-offs that failed before delivery; `retry` only after the last attempt | §3 | 0b |
| 1 | `humanActions` in the ask view; clients show them. `approve` uses the 0b stall. | §4 | 0b |
| 2 | `neo.ask.question` and withdraw; remove `needs_you` and gate settles; fold, inherited approval, item-removal guard; migrate existing needs_you items | §4, §5 | 1 |
| 3 | Derived notifications; refuse non-trigger publications | §7 | 0a, 1 |
| 4 | Watched items and daemon ticks, read-only PR/issue views, deploy readback, daemon-settled cards | §2 | 0b |
| 5 | Scoped snapshot with revisions, views returned from mutations, typed core ops, `work.find` fixes, one session ref | §8 (tools) | none |
| 6 | Quiet routine wakes, one-ask writes, state-only notes | §8 (wakes) | 0b, 4 |
| 7 | Neo-managed close, follow and fold; remove Track; live-human check for human actions; `talk` via `neo.work.refused`, cleared on the session's next human input | §6, §4 (`talk`) | 0a, 2 |
| 7b | Continue and retry another session's card in a live human turn | §6 | none |
| 8 | Merge by the working session; retire `ship.sh` | §10 | 4 |
| 9 | Topic sessions start fresh from a snapshot | §10 | 6 |

Deleted along the way:

- needs_you validation: cites, keyword checks, kinds, cleanup sweeps;
- the reply-limit cap, subsumed by triggers;
- the "no visible output" handling for Neo;
- most done-check and idle-note prose.

## Work in flight

- **Slice 1** (card 121bcf6f, PR #6655): can land its view and question parts now. Its `approve` derivation waits for 0b, so it doesn't turn today's continue-count stall into a button.
- **Ask db080642** (audit fixes 1–4) maps to:
  - fix 1 → slice 4;
  - fix 2 → slice 5;
  - fix 3 → slice 7;
  - fix 4 → slices 0a and 2.
- **#6650 / #6651 (a network outage pauses the turn):** independent, but they change `query-runner`. 0a rebases on them.
- **Duplicate asks** da9506d1 and bf5f5310 fold into slice 2. Ask 6fa377dc's "Choose: fold the publication fix" folds into slice 3.

Shipped behaviour this replaces:

- #6592, #6639, #6646 and #6609 are removed by slices 2 and 3.
- Standing rule 3 (an item Neo can't verify isn't met on an agent's word) becomes a daemon tick wherever the daemon can read, and a question where only the human can check.
- Standing rule 4 (a human decision is its own item) becomes `neo.ask.question`.
- #6225 (Done for a step only the human can do) becomes a question about the result.

## Decided

1. Track goes: the human naming a session in chat is enough.
2. No typed Confirm: every human check is a question, and its options are the buttons.
3. A stall is three wakes in a row without progress.
