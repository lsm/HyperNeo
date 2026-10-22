# Ledger-owned work PR views

Read shared setup in `../SKILL.md`. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-work-ledger-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-work.ts "$RUN"
```

The helper owns an ephemeral loopback daemon, a synthetic DB and refusing fake gh.
No model, GUI, real GitHub, keys or credential files are used; direct HTTP throws.
Five concurrent public `neo.github.read` requests receive the same current-head
approval and unresolved-thread blocker. Before wiring, they cause five work-detail
acquisitions. After, one ledger acquisition serves all five. Other acquisition
families, including ask-reference reads, are not migrated by this slice.

A later human read makes a fresh attempt. Changing the head removes the old
approval immediately; failure returns typed unreadable rather than the prior
success. The ledger retains the prior successful view with failed coverage and
unchanged successful observation time. Reopening the isolated app retains that
stored view, and a subsequent human read makes another fresh acquisition and
recovers coverage. This is app reopen, not an OS-process restart proof.

Pass: `evidence/work-ledger.json` has five successful fanout replies, work-detail
counts `{initial:1, changed:1, detail-failed:1, reopen:1}`, no stale approval after
the head changes, a typed failure, and retained JSON on failure/reopen. Raw fake
lookup records are in `evidence/requests.jsonl`. The old default must fail on the
five-versus-one assertion; a timeout or mismatched RPC reply is inconclusive.

Run `neo-work-ledger`, `neo-work-prs`, `neo-coding-pr-ledger`,
`github-ledger-consumer-contracts`, `neo-ledger-merge-facts` and `neo-branch-ledger`
from `packages/daemon`. Keep all three original consumer RPC scenarios and their
seven initial / three repeated lookup baseline: fresh sequential human reads are
preserved. This slice reduces concurrent duplicate work acquisition; it does not
claim aggregate live request or GraphQL-cost savings. The envelope covers the
existing work-view projection, not raw review eligibility or a new merge gate.

The helper closes its socket and daemon in finally. Retain evidence outside the
worktree, stop only owned services and clean only owned fixtures/caches. After
merge, confirm automatic deployment via owner RPC, verify ancestry and remove the
worktree. No live DB/config writes, forced polls, manual deploy or port 8399.
