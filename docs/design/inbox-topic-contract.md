# Short topics for the Neo Inbox

## Current behavior

The Inbox queue's chips and More menu filter by ask ID. `NeoHumanQueue` labels
both with the ask title, falling back to queue item text or the ID when the
ask is missing. It uses the title even when the ask has a topic. The standalone
topic chips already group by `topicKey` and show `topic`. `NeoLive` hides them
when the queue is present. Session requests have conspicuous titles because
`recordNeoRequestTodo` takes up to 120 characters from the first line.

`neo.ask.propose`, `neo.ask.topic`, `neo.todo.add` with input, and
`neo.topic.merge` accept trimmed strings of 1–12 UTF-16 code units. Propose and
new input asks can omit the pick. Adding a todo to an existing ask keeps its
pick. Session requests open with no pick, project or parent and record the
sender on the reply todo. `neo_asks.topic` is nullable text without a database
constraint. The prompt asks for a lasting area of 2–6 characters in the
human's language. The API checks neither that range nor the language. The
30-day list and nightly merge use stored picks, so plan context can say
`topic=none` for an ask that already has a display topic.

The [derived topic design](ask-topics.md) is already in use. Snapshot ask
entries and individual ask reads take the first available source: the ask's
project (direct or linked through todo targets), one parent (project or pick),
the request sender's local project, the ask's own pick, or `Other` (currently
hard-coded in Chinese). An unlinked or remote sender can miss project
resolution. The derived label uses the full project title, commonly a repository
or folder name. Project titles bypass the pick validator and are a separate
source of long and English labels.

## Recommendation

Use one topic projection for the Inbox queue and ask cards. A smaller option
is to relabel the row as **Asks** and shorten its title labels. That preserves
one-ask navigation and leaves the Inbox without a topic filter.

1. Share a rule that trims labels and allows 2–6 grapheme clusters. Apply it
   to picks submitted by `neo.ask.propose`, `neo.ask.topic`, `neo.todo.add`
   with input, and the destination (`to`) of `neo.topic.merge`. Return a field
   error with the allowed range before any write. Keep the existing rules for
   `from` so it can still identify legacy picks. Guide Neo to reuse labels in
   the human's language and allow established names and acronyms. Localize
   the shared `Other` label at rendering time.
2. Reuse the resolver and its existing source order. At read time, skip
   project titles and stored picks outside the range and continue to the next
   eligible source. A project title within range keeps the project ID as its
   key. Session requests use only the links already available to the resolver,
   including the sender's project. When no source fits, use the shared `Other`
   key. The projection is read-only for open and settled asks. It requires no
   migration, new parent links or cleanup of stored labels.
3. Batch the resolved topics through the existing ask read for every queue
   ask ID, including asks outside the loaded card page. Supply the topics with
   the queue in the Neo snapshot. Use the same topic keys for chips, More and
   filtering. Sum queue counts by topic and state, and keep ask titles on the
   cards. Include every ask in **All**. Opening a card reference clears a
   conflicting filter. Keep the standalone row for snapshots without a queue.

## Acceptance

Extend the [ask-topic proof](../../.claude/skills/verify/journeys/ask-topics.md),
the [topic merge proof](../../.claude/skills/verify/journeys/topic-merge.md),
and the [Inbox queue proof](../../.claude/skills/verify/journeys/human-queue-web.md).
Reject seven-character picks through all four write paths. Check that a
rejected merge leaves its matches untouched and that `from` still accepts a
legacy pick. In the real Inbox, open More with a long session-request title,
an ask with a long project title and a valid pick, and an unlinked request with
an out-of-range legacy pick. Seed two asks in one topic, with one outside the
loaded card page. Check that chips and More use the same short labels and
counts, selection includes both matching asks in the chosen state, and the
unlinked request appears under `Other` and **All**. Confirm the stored legacy
pick remains identical after the Inbox displays its fallback.
