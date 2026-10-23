# Public PR reads use the work ledger

Use the isolated setup in `../SKILL.md`. This reader slice sends explicit PR
URLs directly to the existing work-fact reader. It does not fetch a separate
reference view first. Issue URLs still use reference facts, including GitHub's
issue-URL spelling for a pull request. No schema, RPC, permission, refresh policy
or merge admission changes are introduced.

From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-pr-reader-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-work.ts "$RUN"
```

The helper owns an actual daemon and calls public `neo.github.read` over `/ws`.
Five concurrent PR requests retain the exact current-head approval and unresolved
thread blocker, with zero reference lookups and one work-detail acquisition.
Against the same pre-change fixture, initial logical gh invocations fall from
four to three: work detail, branch rules and blocker detail remain. Later human
reads still refresh, a changed head loses its old approval, and failed detail
returns typed unreadable while prior stored bytes remain. App reopen preserves
the stored view and refreshes on the next demand. A completed issue keeps its
closing PR and parent; an issue URL resolving to a PR still gets its work detail.

Inspect `evidence/work-ledger.json` and `requests.jsonl`. The new contract fails
before the fix on one reference lookup instead of zero. Run the existing
reference journey too: it uses an issue-form PR URL to exercise that route.
Run all three `github-ledger-consumers.ts` scenarios from their journey. Their
current merged-case count becomes six initial and three repeated invocations;
the historical pre-reader baseline was seven and three. Other acquisition
families remain unchanged. These are synthetic logical gh calls, not measured
HTTP requests, GraphQL cost or deployed quota savings.

Run `neo-watch-checks`, `neo-work-ledger`, `neo-ref-ledger`, consumer contracts
and existing GitHub reader suites, plus `bun run check`, on the exact final head.
No provider, GUI, real GitHub, auth files, live DB or port 8399 is used. The helper
refuses direct HTTP and closes its daemon/socket in finally. Preserve evidence
outside the worktree. After merge, verify automatic rollout using owner RPC;
never restart or deploy the human's daemon manually.
