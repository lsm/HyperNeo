# Front answers status from its own reads

In dual-model mode, the front prompt already tells Neo to answer from its reads and call `work_on` when those reads do not suffice (`front.md`), but it never names the read tools. This design gives the front more facts to answer status questions directly.

## Problem

- A todo's detail from `todos_read` returns only `id`, `title`, `state` and `blocker` (`neo-front-read-worker.ts`, `sources.todos`). The worker's `report` and the `evidence` of a finished todo, both stored on `neo_todos`, are left out, and they are what answers "how far along is it".
- Facts a pack keeps about a todo, such as the coding pack's pull request state, are not in the front's reads at all. The core must not learn what those facts are.

## Design

1. **Name the read tools.** In `front.md`, name `projects_read`, `asks_read`, `todos_read` and `cards_read` in the existing reads-first instruction.
2. **Todo detail carries core facts.** The `todos` detail adds `report` (cut to 4000 characters), `evidence` and `updatedAt`. The summary rows used by search and lists are unchanged, so lists stay small.
3. **Packs add facts through the existing snapshot hook.** A pack already exposes `snapshotRows(repos, now, openTodoIds)`, which returns rows from its stored data, each pinned row tagged with `todoId` (the coding pack's rows are read from its PR ledger, not from GitHub). After `todos_read` returns a todo's detail, the tool in `front-model.ts` calls `snapshotRows([], now, [todoId])` on each pack in `service.packs()` and adds the rows whose `todoId` matches as `packFacts: [{ pack, ...row }]`. The core passes them through without reading their fields. The empty repository list returns only the pinned rows, as `session-goal-schedules.ts` already does; `null` would scan every open row. No new pack hook, no live network call, and a pack without `snapshotRows` adds nothing.

## Not changed

Delivery of the full session's answer and single-model mode. The acknowledgment and hand-off are changed by `one-reply.md`. Asks, cards and projects keep their current detail.

## Change

- PR 1: points 1 and 2 (`front.md`, `neo-front-read-worker.ts`). Test: a todo detail carries `report`, `evidence` and `updatedAt`, and a long report is cut.
- PR 2: point 3 (`front-model.ts`). Tests: a todo with a pinned pack row gets it under `packFacts`; rows for other todos and unpinned rows are left out; a pack without `snapshotRows` adds nothing.
