# Neo: the daemon derives what the human sees

Status: proposal. Tracks: epic #6002.

## Why

On 2026-10-12 the human sent Neo 25 messages. Root Neo ran 169 turns, published 415 messages, and its context was compacted 28 times. 122 of those turns started from a "work you handed off went idle" note.

The same failures came back all day, each with its own patch:

- **Gates nobody needs.** Neo told the human to "click Start work", "approve another continuation", "confirm the stopgap rule was removed", and used needs_you to mean "wait for #6618 to merge". We patched this in turn with cites (#6592), English keyword checks (#6639), item kinds (#6646) and cleanup sweeps. Each patch closed one path, and Neo used another. The latest gate came through `neo.ask.settle waiting`, which creates a decision item and skips the approval check.
- **Talking on every event.** Every daemon note starts a turn, and the turn usually publishes something: "CI is running", "still waiting", the same conclusion three times. #6609 caps replies per turn, but not across turns.
- **Acting on memory instead of state.** The "approve again" gate at 14:16Z came from Neo's own compaction summary ("the parent ask's continuation budget has been exhausted after five approved continuations"). That limit hasn't existed since #6588/#6619. The daemon knew the ask was approved and nothing had stalled, but Neo decided from the summary.

The cause is the same each time: **human-facing state is authored by the model in prose, and the daemon then tries to validate the prose.** The fix is to have the daemon derive that state from facts it owns, and to ask the model only for words.

## Principles

1. **What the human must do is derived, not written.** The daemon computes every human action from facts. The model can't create a gate in prose.
2. **When to tell the human is derived, not judged.** The daemon decides that something worth saying happened. The model writes the sentence only then.
3. **Each turn starts from daemon state, not chat memory.** Anything that drives a decision (approval, stall, PR state, items) is read fresh. Memory never overrides it.
4. **One owner.** All work runs under Neo's asks, and merging an approved, green PR is daemon behaviour, not a side script.

## Design

### 1. Derived human actions

Each ask view lists `humanActions`, computed by the daemon on every snapshot. These are the only things a client shows as buttons:

| Action | Derived from |
|---|---|
| `start {workId}` | a card under the ask is `proposed` and the ask isn't approved |
| `approve` | the ask's approval expired (48 h), or a card stalled (3 continues in a row with no progress), per `readContinueBudget` |
| `answer {itemId, options}` | Neo asked a question with options (below) |
| `confirm {itemId}` | an item whose evidence names a machine the daemon can't read (remote daemon, device) |
| `retry {workId}`, `close {workId}` | existing card rules (`retryable`, abandoned) |

A card whose doneWhen the daemon reads itself (its PRs merged, its issue closed) is settled by the daemon without a Neo turn.

The model keeps exactly one way to ask the human something: `neo.ask.question {askId, question, options[2..4]}`. It's a question with choices, answered with one tap, and it is the only human gate the model can create.

Removed:

- `needs_you` as a tick state, and its cite/kind/regex checks (#6592, #6639, #6646).
- `waiting`/`blocked` settles that carry a free-text gate. An ask is waiting exactly when `humanActions` is non-empty, and blocked when a card failed with no retry left.
- "Done" on items. An item is met by evidence the daemon or Neo reads, or by `confirm` for a remote claim.

Clients render `humanActions` and nothing else. The prose of an item is never a button.

### 2. Derived notifications

A publication to the human happens in three cases only:

| Trigger (daemon-detected) | What Neo is asked to write |
|---|---|
| the human sent a message | one reply to it |
| an ask reaches achieved, or every item is met | one sentence naming the outcome |
| an ask gains a `humanAction`, or a card fails with no retry | one sentence naming what's needed or what broke |

The daemon refuses every other `neo.publication.publish`, with a reason. For each derived trigger, the daemon wakes Neo with a note that names the trigger. The publication carries the trigger's id, so it can't be repeated for the same transition.

### 3. Fewer wakes, fresh state

- Routine progress doesn't wake Neo. A PR waiting on CI or review, a check passing, a review starting: the daemon records it and nothing runs.
- Neo wakes for a card report that needs judgement (a reported card with items left), a failure, a stall, a human tick, or a derived trigger above.
- Each wake note carries the ask's current derived state (items, humanActions, cards with PR verdicts), and the system prompt says this state overrides anything remembered.
- A card's report is the working session's reply to the card's own message, capped at about 1.5K, and never includes the human's input. When a card targets a session the human also uses, only turns the card's message started count as the card's idle or report. On 2026-10-12, card 0692a952 got the shared Neo iOS app session's chat as its "report" on every idle: 11 notes and 5 continues for work already done.
- Per-topic avatars (#6579, #6604) hold their asks, and root Neo keeps cross-topic questions only. A topic's session is short-lived and starts from a snapshot, so long compacted chats don't drive decisions.

### 4. One owner, daemon-side merge

- The session that worked on a PR merges it (coding pack). For a PR left approved on its head, CLEAN, with no unresolved threads, for over 30 minutes, the daemon wakes that session to merge it, rather than merging it itself. Deploys stay where they are: the laptop through the daemon's own update hook, the iMac through its session.
- Work goes through Neo asks. Peer sessions get work as cards, not direct messages.

## Slices

Each slice is one PR, behaviour-tested, deployable on its own:

1. **humanActions in the ask view**, derived from existing state. Clients show them. Nothing is removed yet.
2. **`neo.ask.question`.** Remove `needs_you` ticks and gate-carrying settles. Migrate existing needs_you items to questions (with options) or drop them.
3. **Derived notifications:** refuse non-trigger publications, and add trigger notes.
4. **Quiet routine wakes:** CI/review-waiting events stop starting turns. Notes carry derived state.
5. **Merge by the working session:** the daemon wakes a card's session for its PR left approved and clean over 30 minutes. Retire `ship.sh`.
6. **Topic sessions start fresh** from a snapshot. Root Neo keeps cross-topic questions only.

Deleted along the way: needs_you validation (cites, keyword checks, kinds, cleanup sweeps), the reply-limit cap (subsumed by triggers), and most done-check prose.

## Relation to existing work

Open work it touches:

- **#6650 / #6651 (a network outage pauses the turn):** independent, but it changes `query-runner`. Slice 4 waits for it to land.
- **#6604 (topics reorganize):** shipped, but its first manual split of main is still pending. Slice 6 builds on it.
- **#6544 (the human's sessions linked to asks):** a linked session waiting on the human can become a derived action later.
- **#6574, #6568, #6024, #6507:** independent.

Shipped behaviour it replaces:

- **#6592 (cites), #6639 (keyword checks), #6646 (item kinds), #6609 (reply cap):** removed by slices 2 and 3.
- **Standing rule 3** (an item Neo can't verify isn't met on an agent's word) becomes `confirm`.
- **Standing rule 4** (a human decision is its own item) becomes `neo.ask.question`.
- **#6225 (Done for a step only the human can do, such as a manual test):** becomes a question about the result, with options: "Did the keyboard hide?" → Yes / No, or "Is the result what you wanted?" → Yes / Not yet.
- **Merging:** whoever worked on a PR merges it. Neo manages the work; it isn't a worker. Coding-pack guidance already has the card's session run `gh pr merge`, which handles refusals. When a PR sits approved on its head and CLEAN for over 30 minutes (the case `done-check-prs-ready` detects), the daemon wakes that working session to merge it. It doesn't merge it itself. A PR that still doesn't merge is an exception: find its cause and fix it in the system, not with a fallback. `ship.sh` retires.

## Open questions

1. Do `confirm` items need a typed subject (`remote_deploy`, `device`) rather than evidence text?
2. Should question options always include a free-text "other", answered in chat?
3. Is three continues the right stall threshold once routine events stop waking Neo?
