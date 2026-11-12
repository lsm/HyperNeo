# Front answers status from its own reads

In dual-model mode the front model has four read tools for the conversation's projects, asks, todos and cards. Its prompt never mentions them and sends every "uncertain fact" to the full session. This design makes the front answer status questions from its reads, and lets packs add their own facts to those reads without the core naming any pack.

## Problem

- `front.md` line 14 sends screenshots, actions, searches, permission checks, deployment verification "and uncertain facts" to `run_in_background`, and calls the front's own tool limits a reason to do so. A question about progress is an uncertain fact, so the front hands it off even when its reads hold the answer. The human then waits a full session turn for an answer the front could have read in one call.
- `projects_read`, `asks_read`, `cards_read` and `todos_read` are registered in `front-model.ts` (`lookups`), but the prompt does not name them.
- A todo's detail from `todos_read` returns only `id`, `title`, `state` and `blocker` (`neo-front-read-worker.ts`, `sources.todos`). The worker's `report` and the `evidence` of a finished todo, both stored on `neo_todos`, are left out, and they are what answers "how far along is it".
- Facts a pack keeps about a todo, such as the coding pack's pull request state, are not in the front's reads at all. The core must not learn what those facts are.

## Design

1. **Prompt: reads first.** In `front.md`, the hand-off paragraph starts with: "For the state of the human's projects, asks, todos and cards, read them first with projects_read, asks_read, todos_read and cards_read, and answer yourself when they show enough." Its list of hand-off work replaces "uncertain facts" with "facts your reads do not show". The rest of the paragraph is unchanged. The prompt names no pack and no pack concept.
2. **Todo detail carries core facts.** The `todos` detail adds `report` (cut to 4000 characters), `evidence` and `updatedAt`. The summary rows used by search and lists are unchanged, so lists stay small.
3. **Packs add facts through the existing snapshot hook.** A pack already exposes `snapshotRows(repos, now, openTodoIds)`, which returns rows from its stored data, each pinned row tagged with `todoId` (the coding pack's rows are read from its PR ledger, not from GitHub). After `todos_read` returns a todo's detail, the tool in `front-model.ts` calls `snapshotRows(null, now, [todoId])` on each pack in `service.packs()` and adds the rows whose `todoId` matches as `packFacts: [{ pack, ...row }]`. The core passes them through without reading their fields. No new pack hook, no live network call, and a pack without `snapshotRows` adds nothing.

## Not changed

The acknowledgment-first rule, `run_in_background`, delivery of the full session's answer, and single-model mode. Asks, cards and projects keep their current detail.

## Change

- PR 1: points 1 and 2 (`front.md`, `neo-front-read-worker.ts`). Test: a todo detail carries `report`, `evidence` and `updatedAt`, and a long report is cut.
- PR 2: point 3 (`front-model.ts`). Tests: a todo with a pinned pack row gets it under `packFacts`; rows for other todos and unpinned rows are left out; a pack without `snapshotRows` adds nothing.
