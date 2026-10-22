# Todo state from facts

## Core and packs

Core and packs are fully separate. Core knows only generic facts: the dispatch
record (todo → session, dispatch id), session live status, open questions, and the
worker’s explicit result (“result for todo X” + dispatch id). Core knows nothing
about PRs, CI or merges. A pack answers domain questions through two functions:

- `pack.readFacts(todo)` does the I/O; e.g. the coding pack reads its PR ledger rows.
- `pack.judge(todo, facts)` is pure and returns `done | failed | blocked(reason) | no opinion`.

The pack tells core “facts changed for todos [ids]” to trigger a recompute.
PR→worker messages (CI failed, review, conflict, ready to merge) are the coding
pack’s own job, sent from the ledger only. Move the coding code out of core:

- `service.ts` constructing the ledger/events/sweep repos and the GitHub readers.
- `operations.ts` and project-tree importing github-read/query/ask-prs.
- driver-work’s `/merg/` regex and PR prompts.

Add a CI check: core may not import from `packs/`.

## One state writer

Keep the existing state column and its readers. Only one function,
`recompute(todo)`, may write it. Removal is explicit intent; recompute never touches a removed todo (never resumes or re-dispatches it).

The existing remove operation passes removal intent into this pipeline; its write stage persists `removed` while preserving session-stop and start-question cleanup.

Precedence:

1. **done:** the pack says met; for todos without a pack, the human confirms; a worker’s claim alone never counts.
2. **failed:** the pack says so.
3. **blocked:** an open question; the session stopped, failed or needs_you; or the pack says so.
4. **doing:** dispatched.
5. **todo:** not dispatched.

Recompute and store when a fact changes (session status change, question answered,
result submitted, pack notification). Page loads just read the column.

## SuperPipe and pure functions

`recompute` is a SuperPipe pipeline: read → decide → write.

- `decideTodoState(facts, packJudgement, now)` is pure: no DB, no clock; `now` is passed in.
- Stall planning `planNudge(incident, progress, now)` is pure, like `planCodingPrNudge`.
- I/O happens only in the read and write stages, so most verification becomes plain unit tests on data.

## One stall ladder

At 20 min remind the worker, at 40 min remind again, at 60 min go to Neo. Reset it
only on real progress, and persist it so a restart doesn’t reset it.

## Delete

- The 6 state writers.
- The in-memory idle/checked maps.
- The three result-inference fallbacks.
- The second ladder.
- `pack_coding_pr_claims`, the per-todo card event subscriptions and the `claimed` switch.
- `neoAskIdleNote`.

Dropped from the draft: shadow/dual-run compare, backfill, migration review items,
“intent revision” and “dispatch generation” (keep just a dispatch id). Open todos
are simply recomputed at cut-over.

## Steps

One small PR each:

1. Pin current behavior with tests.
2. Core/pack split + the two interfaces + the import check.
3. Recompute as the only writer, then cut over.
4. Explicit worker results; delete the inference fallbacks.
5. One ladder; PR messages from the ledger only.
6. Delete the old code.

Only the PR-related parts of steps 3 and 5 waited on the GitHub single-source
ledger (#8135); #8135 is already merged as `33e2fd11`, so nothing waits now.

Merge policy is the repo’s saved one: eligible bot approval on the exact current
head, green CI, manual squash, deploy build readback. Put each PR’s worktree under
`~/focus/worktrees/<name>`, remove it when the PR merges or closes, and stop any
test daemon started there.
