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

1. Share one display-width rule. Trim picks and require a nonempty label with
   at most 12 cells. Count CJK and fullwidth characters as two cells and Latin
   characters as one. Measure and truncate at grapheme boundaries, with
   combining marks adding no cells. Use fixed widths for other text: two cells
   for emoji graphemes and one for other narrow or ambiguous-width text,
   including the ellipsis. Apply the rule to picks from `neo.ask.propose`,
   `neo.ask.topic`, `neo.todo.add` with input, and the `to` of `neo.topic.merge`.
   Reject invalid picks with a field error before any write. For `from`, accept
   either a valid new pick or a legacy pick within the old 1–12 UTF-16 code-unit
   range. Match either source using the existing case and spacing rules.
   Update the prompt and tool guidance to the same budget and keep established
   names and acronyms.
2. Reuse the resolver and its existing source order. Keep a resolved project
   as the source regardless of title width, using its project ID as the key.
   Shorten an over-width project title to the longest prefix that fits with a
   one-cell ellipsis within the 12-cell budget. For over-width legacy picks,
   continue to the next eligible source at read time. Session requests reuse
   existing links, including the sender's project. When no source fits, use
   the shared `Other` key and localize its label at rendering time. The
   projection is read-only for open and settled asks. It needs no migration,
   new parent links or cleanup of stored labels.
3. Batch the resolved topics through the existing ask read for every queue
   ask ID, including asks outside the loaded card page. Supply the topics with
   the queue in the Neo snapshot. Follow iOS's shared-key behavior on the web:
   chips, More and filtering use the same topic keys. Sum queue counts by
   topic and state. Keep ask titles on the cards and include every ask in
   **All**. Opening a card reference clears a conflicting filter. Keep the
   standalone row for snapshots without a queue.

## Acceptance

Extend the [ask-topic proof](../../.claude/skills/verify/journeys/ask-topics.md),
the [topic merge proof](../../.claude/skills/verify/journeys/topic-merge.md),
and the [Inbox queue proof](../../.claude/skills/verify/journeys/human-queue-web.md).
Through all four write paths, accept `HyperNeo`, `neo-ios`, a two-character
CJK label and a 12-cell label. Reject a 13-cell label. Check that a rejected
merge leaves its matches untouched and that `from` still accepts a legacy
pick over 12 cells. Save five CJK characters followed by a family emoji
joined with zero-width joiners (12 cells, 16 UTF-16 code units), then use that
label as `from` in a merge and verify the saved ask receives the destination.

In the real Inbox, open More with a long session-request title, two projects
that shorten to the same label, and an unlinked request with an over-width
legacy pick. Verify that both project labels fit within 12 cells, including
the ellipsis, and each remains selectable by project ID. Seed two asks in one
project, with one outside the loaded card page. Check that the chips and More
use the same labels and counts, and selection includes both asks in the
chosen state. Verify that the unlinked request appears under localized
`Other` and **All**, with its stored legacy pick intact.
