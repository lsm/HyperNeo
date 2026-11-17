# Ask topics come from facts first

Status: proposal, 2026-11-16. Design only. Builds on the ask topic (#10197) and the project
mirror (`neo-projects.md`). Paths without a prefix are under `packages/daemon/src/lib/neo/`.

## Why

The Live page groups asks by topic. Topics spread: one code project ends up under many
topics, the same matter gets two names (a word and its synonym, or two spellings of a
name), and asks land in the wrong topic or in "Other". Many people never open the inbox
to fix this, so the grouping has to be right on its own.

Four facts in the code cause it:

1. **Neo writes every topic as free text.** `neo.ask.open` and `neo.ask.topic` take any
   string up to 12 characters (`Topic` in `ask-record-operations.ts`). Nothing in the
   daemon knows which topic an ask belongs to.
2. **Neo only sees topics on open asks.** The plan lines list open asks only
   (`neoPlanLines` in `plan-context.ts`), and the prompt says "reuse a topic already on an
   open ask" (`packages/prompts/src/neo/system/root-turn-end.md`). Once an ask settles, its
   topic is invisible, so the next ask on the same matter gets a new name.
3. **The prompt asks for the narrowest name.** "The matter's short name, 2-6 characters"
   with examples such as a single application or "email". Each matter becomes a topic.
4. **Asks made by the daemon get no topic.** A request from another session opens its ask
   in `recordNeoRequestTodo` (`request-todo.ts`) with no topic, and Neo rarely sets one.

Meanwhile the daemon already knows the project of most work. The project mirror links every
work session and folder to a project through aliases (`work:…` and `folder:…` in
`packs/coding/project-mirror.ts`, stored in `neo_project_workspaces`), and each project has
a title (`neo_concerns.title`).

## The design

**1. An ask's topic is derived when it is read.** The read that builds `NeoAsk` returns the
first of these that exists:

1. **Its project.** The ask's own `project_id` when it names a project other than the
   inbox. Otherwise the project linked to the targets of the ask's todos
   (`neo_todo_sessions.target`: the session ref through its `work:` alias, or the start
   place through its `folder:` alias); with several, the one with the most todos, and on a
   tie the earliest todo's. The topic is the project's title.
2. **Its origin, one step only.** For a follow-up ask, its parent (`parent_id`), which
   contributes only its rule 1 result or its stored pick, never its own origin. For a
   request from a session, the sender session's project. One step keeps a read to at most
   one other ask, so it cannot loop, and stops a topic from drifting down a chain of asks
   that each moved on to something else. A sender's earlier requests are not used: one
   session can ask about unrelated matters, so a sender with no project falls to rule 3.
3. **Neo's pick:** the stored `topic`.
4. Otherwise "Other".

Nothing is backfilled: every existing ask is grouped by the same rule the next time it is
read, and nothing has to be kept in sync. Code work, worker requests and follow-ups then
need no choice from Neo, and one code project is one topic.

**2. Neo picks a lasting area, from the full list.** The prompt line changes to: a topic is
a lasting area of the person's life or work, such as a project, a child, money, the home or
health, not a single matter; reuse a topic from the list; add one only for a new area. The
plan context gains one line listing every topic used in the last 30 days with its ask count,
open or settled. Neo's pick only matters for asks with no project or origin, which are
mostly personal ones.

**3. A topic has a key.** The read also returns `topicKey`: the project id for a project
topic, and `pick:` plus the name with case and spacing folded for Neo's pick. Two projects
with the same title stay two topics; two picks that differ only in case or spacing are one.
The topic chips group by `topicKey` and show `topic`.

**4. The daily pass tidies Neo's picks.** The existing daily reorganize pass
(`reorganize-nightly.ts`) gives Neo one turn with Neo-picked topics and their counts, and
Neo may fold one into another with a new `neo.topic.merge {from, to}`. It rewrites the
stored `topic` from `from` to `to` on every ask, open or settled, in one update; nothing
else is stored. The 30-day list then no longer shows `from`, so later picks reuse `to`.
Project titles are not Neo's picks and are never rewritten this way.

## What does not change

`neo.ask.open` and `neo.ask.topic` keep their inputs; the stored topic becomes Neo's pick.
Projects, the project mirror, and the chips' look and colours. Asks without todos or origin
behave as today, apart from the prompt.

## Change plan

Each slice is one PR from `dev` (the repository's default and target branch), failing tests
first.

1. **Derived topic.** Rules 1 to 4 of point 1 and point 3 in the ask read
   (`packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts`), as a pure
   function over the ask, its todos' targets, at most one origin ask and the alias table.
   About 120 production lines.
2. **Prompt and plan context.** The prompt line, the tool text of `neo.ask.open` and
   `neo.ask.topic`, and the 30-day topic list in `plan-context.ts`. About 40 production
   lines.
3. **Daily tidy.** `neo.topic.merge` and the turn in the daily pass. About 80 production
   lines.

`bun run system-map impact` on `neo-ask-todo-repository.ts`: 54 importers, 32 of them in
`lib/neo`. `topic` keeps its type (`string | null`) and `topicKey` is a new optional field,
so none is forced to change. In slice 1 every web consumer that groups or compares by topic
switches to `topicKey` and keeps `topic` only as the label: the chip counts
(`packages/web/src/neo/NeoTopicChips.tsx`), and in `packages/web/src/neo/NeoLive.tsx` the
selection, the saved filter (`neo:topic-filter` in local storage), the list filter and the
card's topic button (`onTopic` in `NeoAskTodos.tsx`). A saved filter that holds an old label
matches no ask and is ignored, as an unknown topic is today (`NeoLive.tsx` line 321). The colour stays keyed by label.

Acceptance, as tests on the pure function and one integration case per row:

| Case | Expected |
|---|---|
| An ask whose todo runs in a session of project P, with Neo's pick "X" | topic is P's title |
| Two asks in the same project with different Neo picks | the same topic |
| A request from a session of project P | topic is P's title, with no Neo call |
| A follow-up ask with no project, whose parent's project or stored pick is T | topic T |
| Two projects both titled P | two topics named P |
| Picks "kids" and "Kids" on asks with no project | one topic |
| An ask with `project_id` P and no todos | topic is P's title |
| A follow-up of a follow-up whose grandparent alone has a topic | "Other": one step only |
| Neo merges "A" into "B" | every ask stored as "A" now stores "B"; "A" leaves the list |
| An ask with nothing at all | "Other" |
| A request from a session with no project, after its earlier request in topic T | Neo's pick, not T |
| Web, with two projects titled P and picks "kids" and "Kids": select each chip, reload, click a card's topic | each P chip shows only its project's asks; "kids" shows both picks; the saved filter and the card button select the same set |

## Risks

- **A project's title is not the name the person uses.** It is the folder or repository
  name. `neo.project.save` (`project-save.ts`) already changes a project's title, and the
  topic follows it.
- **One ask spans two projects.** It shows under the one with more todos, which matches
  where most of its work is.

## Out of scope

Moving an ask to another topic by hand in the UI, and nesting topics.
