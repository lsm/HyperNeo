# Built-in pack runtime extraction (step 6a)

This is an Extract rung: move existing reader/pack construction without changing
policy, query selection, schemas, dispatch, state or delivery. Read shared
SKILL.md isolation setup. No model, provider, browser, credential files or real
GitHub is needed. Both helpers own their synthetic daemon/socket listeners and
close them in finally; neither calls port 8399.

Before and after the extraction, run each command from the worktree root with
a new RUN. Keep baseline and final evidence separately outside the worktree.

```sh
RUN=$(mktemp -d /private/tmp/hn-pack-runtime-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" \
  PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/todo-plan-recompute.ts verify "$RUN" --lifecycle
```

The existing `pr_merged` plan must advance and recover exactly once through the
actual synthetic Codex socket. Report hashes, removal, question ownership,
retry input identity and attempts survive restart. Then repeat the fresh RUN
setup with `coding-issue-nudges.ts verify "$RUN"`: COMPLETED advances once,
NOT_PLANNED fails, open/unreadable wait, failure blocks survive, and persisted
20/40/60 reminders never block. Raw PR events add no worker frame.

Retain both `evidence/observed.json` and `gh.log`; compare outcomes and recorded
GitHub request shapes, without claiming a live quota reduction. This extraction
does not implement the separate single-source ledger acquisition lane.

Run the package-local `neo-service-packs`, `neo-github-query`,
`neo-coding-todo-prs`, `neo-coding-issues` and `neo-life-admin-pack` contracts
unchanged before and after. Their new pins intentionally pass on the baseline:
installed builtins retain identity/enablement and late service reader overrides
remain visible to legacy and issue checks without writing todo state.

After merge, verify owner-RPC build ancestry without a live restart, stop owned
resources and remove the worktree. Step 6b removes the remaining core imports;
step 6c deletes only the obsolete paths and keeps `pr_merged` supported.
