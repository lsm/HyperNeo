# Ledger-owned ask and project references

Read shared setup in `../SKILL.md`. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-ref-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-refs.ts "$RUN"
```

The helper owns its loopback daemon, synthetic DB/HOME and refusing fake gh.
No model, GUI, real keys, auth files, GitHub or port 8399. Direct HTTP throws.
It seeds a synthetic code project and workspace mapping in its own DB only.

Five concurrent public `neo.github.read` requests using an issue-form PR URL must produce the same
current approval/blockers and one ask-reference lookup (before: five). A public
issue-detail read and `neo.project.section` for the same epic share one lookup.
The section succeeds with the epic title, and issue completion retains its
closing PR and parent. The workspace match/admission gates remain unchanged.

A later open-PR read refreshes the default-branch observation and head verdict.
A failed source attempt returns typed unreadable, retains prior JSON and does
not advance successful observation time. App reopen preserves those facts;
a fresh open-reference attempt recovers. This is app reopen, not an OS restart.

Pass: `evidence/ref-ledger.json` has `verified:true`, five successful fanout
replies, `refLookups:1`, `issueLookups:1`, a successful section, and reference
counts `{initial:1,changed:1,failed:1,reopen:1}`. Raw synthetic command records
are retained in `evidence/requests.jsonl`. A timeout is inconclusive; the old
default must fail on five-versus-one acquisition.

Run `neo-ref-ledger`, `neo-ask-evidence`, `neo-project-tree` and all existing
ledger consumer/query/work/branch/merge suites from `packages/daemon`.
Tests cover missing/stale/failed coverage, unchanged fact revision, aliases,
issue closing/parent evidence, cross-connection late responses and transient
SQLite contention. Acquisition bypasses legacy global terminal/missing caches;
they cannot be re-stamped as fresh observations. A known merged-PR observation
may be reused locally for less than two minutes with its original timestamp;
expiry refreshes mutable default-branch evidence. Failed refresh never falls
back to prior success. Reopen reuse must make zero source calls and keep the
successful observation timestamp unchanged.

The original three consumer scenarios keep the seven-initial/three-repeated
logical lookup baseline. This slice removes concurrent duplicate reference
acquisition; it does not claim aggregate deployed HTTP or GraphQL-cost savings.
The envelope covers the existing reference projection, including its existing
ten closing-PR cap, not exhaustive issue timelines or review eligibility.
The helper closes its socket/daemon in finally. Retain evidence outside the
worktree; stop only owned services. After merge, read back automatic deployment,
verify ancestry and remove the worktree. Never force a live poll or deploy.
