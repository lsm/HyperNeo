# Production readiness facts come from the ledger

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
Three concurrent production `pr_ready` decisions and two connector readiness
reads must share one basic acquisition and one complete review-thread acquisition:
two logical calls in total. A separate fresh run with `baseline` as its third
argument binds only the basic reader, observing the previous six-call path
(one basic acquisition and five direct thread queries).
This measures synthetic calls, not live quota or GraphQL cost.

Restart must retain both fact families. Unresolved threads block with their link.
Failed or partial thread refreshes block without falling back and retain prior
thread JSON/success time; recovery allows. Each later decision refreshes. UNKNOWN mergeability
retries, CLOSED blocks, failed refresh blocks while preserving prior JSON and
successful observation time, and recovery allows. Unknown/closed/failed basic
facts must not trigger a thread query or direct basic fallback. Unit contracts
also pin existing rate-limit delay and the readiness deadline for a shared read.
The caller timeout does not cancel an acquisition other consumers share.

Pass: evidence/pr-ready.json is verified with coldReads 2 and the exact per-phase
basic/thread counts. Retain its requests.jsonl too. Fake gh refuses unknown
commands, direct fetch throws, and both daemon instances stop in finally. No
real keys, auth files, live DB/copy, provider scheduling, browser, or port 8399.
PR URL discovery and unbound standalone compatibility remain later slices; this
proof does not claim those paths are ledger-backed. No headless or native UI is
needed for this workflow decision.
