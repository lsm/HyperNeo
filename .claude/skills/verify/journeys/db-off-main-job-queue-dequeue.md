# Job claims do not block the daemon behind feed purge

Read shared SKILL.md. Use pinned Bun1.4.2 and a new synthetic HOME/data/DB.
No model, GUI, credentials, real DB copy or live daemon mutation is needed.

```bash
RUN=$(mktemp -d /private/tmp/hn-job-dequeue-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/job-queue-dequeue-worker.ts "$RUN"
```

This reuses the real app-wired Claude feed job and independent child health RPC
proof. A synthetic slow purge holds SQLite's write lock. At default concurrency5,
main-loop lag must stay below1s and health below250ms while the existing writer
owns dequeue/claim requests. Source hashes and unrelated Codex rows stay intact.
The test-first commit must fail against the synchronous processor's claim path.
Keep `evidence/purge.json` including transaction caller stacks and worker metrics.
This controlled cost does not establish the historical physical disk cause.
Repeat with `VERIFY_WRITER_IPC=1`; rerun job-queue-cleanup-worker.ts on a second
fresh fixture. Report affected job/worker latency separately from responsiveness.
After the feed daemon closes, two existing writer clients compete for20synthetic
jobs in the same fixture DB. `evidence/dequeue.json` verifies20unique claims and
completions, complete payloads, wrong-token rejection, FIFO heads/tail and exempt
session exclusion. Unit coverage also holds a claim reply across stop and races
overlapping processor ticks; stop must drain the accepted handlers without loss.
The online multiple-steer case waits for both exact user UUIDs in the SDK page,
not just an older-message count or an empty enqueued queue. Strict acknowledgement,
timestamp and consumed-count assertions and the existing timeout remain in place.
