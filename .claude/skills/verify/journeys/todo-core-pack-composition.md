# Pack-owned service composition (step 6b1)

This Extract rung moves existing coding reader/repository construction and
completed-card retention, event-refresh and session-link decisions out of the
core service. The composition factory supplies installed packs, defaults and
existing project operations. Core selects only supplied packs. No state,
dispatch, claim, authorization, schema or request policy changes are intended.
The remaining implementation moves and full core import check belong to 6b2;
obsolete-path deletion belongs to 6c.

Follow the shared isolation setup and `todo-core-pack-runtime.md`, keeping a
fresh RUN for each helper. Run `todo-plan-recompute.ts verify "$RUN" --lifecycle`
before and after extraction, then `coding-issue-nudges.ts verify "$RUN"` on the
final head. The actual daemon RPC and synthetic Codex socket must show the same
stored plan advancing exactly once, surviving restart, retaining full reports,
and preserving removal, question ownership and retry identity. Legacy
`pr_merged` claims keep working. COMPLETED issues advance, NOT_PLANNED fails,
and open/unreadable issues and persisted nudges never manufacture completion
or timeout blocks. Raw PR events add no worker frame.

Keep each helper's `evidence/observed.json` and `gh.log`. Compare the before/after
plan outcomes and GitHub request multiset without claiming live quota savings.
Run the affected service, prompt, pack selection, legacy/issue
contracts. The service/prompt import contract must fail on the base and pass
on the final head; fixture callers now use the pack composition factory.
Both helpers close owned listeners in finally; no real HOME/DB, credential,
model, GUI or port 8399 is used. After merge record owner RPC build ancestry,
remove the worktree and unlink the merged PR attachment.
