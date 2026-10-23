# Worker completion reads ledger PR state

Use shared isolation in `../SKILL.md`. No model or HTTP mock is needed.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-completion-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-completion-gate.ts "$RUN"
```

The helper owns an actual daemon and invokes its existing `task.transition`
operation through the MCP adapter as synthetic, active, bound post-approval
workers. It exercises the completion binding wired in `rpc-handlers/index.ts`.
A human RPC transition deliberately bypasses this worker gate under existing
policy, so a human RPC-only test would be the wrong surface. This journey adds
no RPC, permission, schema, provider turn or GUI test. Fake gh refuses unknown
commands and direct HTTP throws; no real keys, credential files, live DB or port
8399 is used. Resources close in finally.

A covered merged fact settles a worker task while fake GitHub refuses and makes
zero lookups. The pre-fix gate leaves it approved with an explicit verification
error. Five concurrent tasks with the same missing PR state settle after one
ledger acquisition, compared with five legacy direct reads. Run the same helper
with a third argument `baseline` on the pre-fix commit to record those five reads.
A repeated covered merge makes zero additional lookups.

OPEN and CLOSED facts still reject completion and are refreshed, rather than
hiding a new merge behind their freshness window. Failed/latest or incomplete
merge evidence leaves the task approved with its error; a failure retains the
prior value and successful observation time. Other task admission rules, the
frozen PR URL and human override policy are unchanged. No manual pack completion,
terminal unsubscribe or connector behavior is changed in this slice.

Pass: `evidence/completion-gate.json` has `verified: true`, `knownStatus: done`,
five cold completions, `coldReads: 1`, and counts
`{cold:1, open:1, closed:1, merged:1, failed:1, partial:1, recovered:1}`. Keep the actual
`requests.jsonl`. These are logical gh calls, not GraphQL cost or live quota.
Run completion-gate/complete-task contracts, the ledger merge/deploy suites and
full checks on the final head. After merge, confirm automatic rollout with owner
RPC and repeat the synthetic proof using that deployed checkout. Never deploy or
restart the human's daemon. Remove the worktree and unlink the merged PR.
