# Production PR-ready basic facts come from the ledger

Use the shared isolation in `../SKILL.md`; no model or GUI is needed.

```bash
RUN=$(mktemp -d /private/tmp/hn-pr-ready-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-pr-ready.ts "$RUN"
```

The helper owns a fresh daemon/DB and drives the production `pr_ready` built-in
through HookExecutor with the same bound reader the daemon supplies to workflows.
Five concurrent decisions must allow with one basic PR acquisition and five
unchanged review-thread queries: six logical calls in total. A separate fresh
run with `baseline` as its third argument observes ten calls, five of each kind.
This measures synthetic calls, not live quota or GraphQL cost.

Restart must retain facts. Each later decision refreshes. UNKNOWN mergeability
retries, CLOSED blocks, failed refresh blocks while preserving prior JSON and
successful observation time, and recovery allows. Unknown/closed/failed basic
facts must not trigger a thread query or direct basic fallback. Unit contracts
also pin existing rate-limit delay and the readiness deadline for a shared read.
The caller timeout does not cancel an acquisition other consumers share.

Pass: evidence/pr-ready.json is verified with coldReads 6 and the exact per-phase
basic/thread counts. Retain its requests.jsonl too. Fake gh refuses unknown
commands, direct fetch throws, and both daemon instances stop in finally. No
real keys, auth files, live DB/copy, provider scheduling, browser, or port 8399.
PR URL discovery, review-thread acquisition and unbound standalone compatibility
remain later slices; this proof does not claim those paths are ledger-backed.
