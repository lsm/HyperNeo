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

1. Apply one validator to new topic picks and project topic labels. Trim and
   require 2–6 user-perceived characters. Return a field error with the allowed
   range and leave the record unchanged. Apply it to the merge destination.
   Keep legacy labels usable as merge sources for cleanup. Guide Neo to reuse
   labels in the human's language and allow established names and acronyms.
   Language identification on such short text is unreliable, so keep it as
   authoring guidance and localize the shared `Other` label at rendering time.
2. Keep the existing source order and reuse the resolver. Give projects an
   optional short topic label and keep the project ID as the key. A project
   with a suitable short title can use that title. Have Neo set a short label
   for projects with long or unsuitable names. Until then, let the resolver
   continue to the next usable source. For session requests, inherit a parent
   only when an explicit ask reference can be resolved and authorized. Reuse
   the sender's project when it resolves. Otherwise use a valid pick or `Other`.
   Keep that context separate from follow-up ownership and settlement.
3. Batch the resolved topics for all queue ask IDs, including asks outside
   the loaded card page. Group the row and More by `topicKey`. Sum the existing
   queue counts by topic and state, and keep ask titles on the cards. Include
   every ask in **All**. Opening a card reference clears a conflicting filter.
4. Apply derivation to history at read time. Preview a cleanup of legacy picks
   across open and settled asks. Use the existing case- and spacing-folded
   merge for clear aliases, and leave ambiguous rows for review while the
   projection uses its fallback. Keep inherited topics derived to avoid
   copying project labels into every ask.

## Acceptance

Extend the [ask-topic proof](../../.claude/skills/verify/journeys/ask-topics.md)
and the [Inbox queue proof](../../.claude/skills/verify/journeys/human-queue-web.md).
Reject seven-character writes through each entry point. In the real Inbox,
open More with a long session-request title, two asks sharing a topic, a long
project title with a short topic label, and an unlinked request. Check that
More shows the same short labels as the chips, selection finds every matching
ask in the chosen state, and `Other` and **All** include the unlinked request.
