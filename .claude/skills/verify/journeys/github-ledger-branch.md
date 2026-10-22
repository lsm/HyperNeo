# Ledger-owned branch membership

Read shared setup in `../SKILL.md`. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-branch-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-branch.ts "$RUN"
```

The helper owns an ephemeral loopback daemon, local synthetic repositories and a
fake gh executable. It rejects all non-branch commands (including auth discovery)
and direct HTTP, and uses no provider, model, GUI or real keys. Two synthetic
worker sessions have different checkouts of the same GitHub repo and branch.
Public WebSocket `work.find`, `work.status` and `neo.snapshot` observe the running
daemon. Only its own existing driver-refresh job is made due; the real handler,
watcher and default branch reader execute unchanged.

Pass: `evidence/branch-ledger.json` shows the completed actual watcher job,
canonical `synthetic/ledger` coverage for branch `feature`, and one branch lookup
for both checkouts. Another checkout reads that persisted coverage without an
upstream call. The retained direct legacy reader makes two calls for the same
pair. Reopening the isolated daemon runs its real watcher again and makes zero
new branch calls. The expected count is `{watch:1, legacy:2, reopen:0}`.
Before wiring the default initializer, the same watcher completes with two branch
lookups and missing ledger coverage, so the helper fails. This proves the actual
acquisition path; it does not claim a new card UI or a model response.

Membership is explicitly bounded to the existing `state=all, limit=5` query.
Known means that bounded query succeeded, not that every historical PR on the
branch was enumerated. Missing, stale, failed or partial coverage is unknown;
old stored URLs are retained but do not become a fresh read. Concurrent demand
for one canonical repo/branch coalesces across collector instances sharing the
same DB. The observation revision prevents a late response on another connection
from replacing newer facts. An unchanged successful refresh keeps factRevision.
Rate refusals remain unknown until retry-after permits another attempt.

Run the `neo-branch-ledger`, `neo-branch-prs`, `neo-coding-pr-ledger` and
`neo-ledger-merge-facts` unit suites from `packages/daemon`. They also cover empty
membership, stale/failure/recovery, overflow refusal, aliases and deterministic
out-of-order responses. Fork checkouts also keep GitHub CLI remote priority and
explicit gh defaults using only local remote/gh-resolved metadata. Enterprise HTTPS, SSH and scp-style remotes keep their host-qualified identity, separate from github.com membership; host-qualified gh defaults select the specified server. Repeat the helper with a fresh RUN and append `enterprise` after `"$RUN"` to exercise the actual watcher/reopen path against the fake ghe.example host. Before the fix this returns unknown coverage; after it the same 1/2/0 counts pass without real Enterprise access. Repeat all three `github-ledger-consumers.ts` scenarios
from the consumer-contract journey. Their seven initial / three repeated lookup
baseline stays unchanged: this slice reduces duplicate branch demand and restart
reads, not the other six acquisition families. Synthetic lookup counts are not
GitHub GraphQL cost or aggregate live quota savings.

`evidence/requests.jsonl` retains exact synthetic gh invocations. Source logs
`PR ledger branch GitHub read` contain only repo, lookup count and success, never
credentials or response text. Keep live/deployed measurements separate: existing
production branch reads had no comparable per-family counter. Confirm the merged
commit via owner RPC and collect actual subsequent lookup logs read-only; do not
invent a pre-deploy aggregate count. All owned daemon instances close in finally.
