## Copilot resumable input delivery (worker slice 4)

Run from the worktree root, using a fresh run and free loopback port:

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-inputs-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-send-queue.ts 9385 "$RUN"
```

The actual isolated daemon, public `operation.invoke` door and pinned official
SDK drive a synthetic framed-JSON-RPC process. No real Copilot sessions,
credentials, provider, live DB or GUI is used. Evidence is
`$RUN/evidence/observed.json`; the helper always closes its owned daemon/socket.

Observe these results:

- `work.send` after terminal reaping and daemon restart resumes the same owned
  session ID with the stored model/directory, empty tools, default-deny permission
  handler and `continuePendingWork: false`. It returns a new receipt, never
  recreates the session or replays its old input. Both replies survive restart. The journey removes only its synthetic receipt
  directory before resume to prove migration of slice 3 snapshot-only records.
  Status without a receipt follows the latest accepted input and keeps
  startReceipt unchanged; after an unknown ACK it reports unreachable instead
  of presenting a previous reply as current work.
- While the first task waits on the synthetic `release-serial` marker, ordinary
  send and explicit `work.queue` both use enqueue. Their ACK receipts are pending
  (`delivered: false`, queue ID equals input ID). After release, each receipt
  yields only its own complete report; the final report is 27,000 characters and
  remains intact after restart. Acceptance alone does not prove consumption.
- More than 64 completed receipts cross the owner's cache boundary while one
  input remains active. The early receipt still returns its full completed reply
  before and after stop/restart. Per-receipt JSON is separate from the bounded
  worker snapshot and is never inferred from a transcript tail.
- Blocked permission returns busy before sending. External refs are not adopted.
  Unfinished orphaned sessions and unknown ACKs remain unreachable without replay.
  Previously complete receipt evidence stays available after owner loss; when
  runtime status cannot be recovered, its recorded outcome supplies that
  receipt-bound read's status, not a claim about uncertain later input.
- Receipt-write failure after start reports unreachable and reaps its runtime
  without a status/stop request. The fixture makes only its synthetic receipt
  temporary path unwritable; restart cannot resume uncertain work. Accepted
  input intent is persisted before transport, and successful ACKs are persisted
  before returning. No automatic retries occur.
- All fixture PIDs disappear on cleanup. Capabilities include send/queue and
  exclude steer/withdraw. Explicit steer remains unsupported with no fallback.

Use the final argument `resume`, `queue`, `retention`, `unsafe` or `persist` to
isolate a case; `receipt` checks unknown prototype-like IDs and model refusal
before resume/send. Unknown IDs never report consumption or borrow another reply. Run the adapter/worker/discovery/input suites serially with the
daemon Vitest runner. Additional tests cover full 64-input admission and refusal
without an extra send, and immediate persistence failure preserving old evidence.
Rerun the earlier discovery, construction and lifecycle journeys after changes.
Shared setup remains in SKILL.md; there is no journey index.

Real CLI 1.0.105 / SDK 1.0.28 compatibility, real queue scheduling/resume behavior,
real account quotas/cost, Desktop/IDE visibility, tool execution and process-tree
containment remain unverified. The fixture impersonates the pinned CLI and
implements only its synthetic protocol. Tools remain unavailable and permissions
reject on create and resume. No arbitrary external or unfinished session is
loaded. Receipt files intentionally retain durable evidence; bounded history reads and owned work.find overlay are covered by
copilot-owned-history-find.md. No history/receipt retention deletion policy is introduced.

Use mode `writes` for receipt I/O behavior. Hold open descriptors to a completed
receipt and an unrelated pending receipt, emit twelve synthetic assistant message
fragments for the active input, then compare descriptor/path inode identities.
Neither unchanged file may be replaced, while the active input retains all
fragments. Abort must replace the pending receipt to persist its changed outcome,
leave the completed file untouched, and preserve that full completed report after
restart. Keeping the descriptors open prevents inode reuse from hiding a rewrite.
The default journey includes this case. The owner's persistence cache advances
only after successful writes and is pruned with its bounded receipt cache; no
unchanged full reports are serialized or rewritten by the persistence callback.

Mode `legacy-read` removes only the fresh fixture's per-input receipt directory,
then reads generic and receipt-bound status before any resume/follow-up. Terminal
snapshot-only records must retain their full report, and live records must stay
running. After daemon restart, terminal reads remain identical while unfinished
ownership is unreachable (never not_found/gone). No receipt directory is created
by those reads and no SDK resume is sent. This case characterizes the existing
snapshot fallback and also runs in the default journey. Neo's consumer test pins
that delivered:false with a Copilot receipt/queue ID produces accepted queued
work and retains attribution; operation help now states this enqueue behavior.

Mode `preflight` injects login-required, incompatible-version and resume-rejected
responses before any follow-up is submitted. Each reports its actual diagnostic
without claiming accepted input or prohibiting replay; the fixture receives no
send, the old reply remains readable, and an explicit retry after fixing only
the synthetic runtime succeeds once. No real logout/login or account is used.
The same mode holds an ACK behind `release-ack`, makes the synthetic ownership
record temporary path unwritable after send begins, then releases ACK. That
post-ACK persistence failure must retain the do-not-replay warning and prevent
restart resubmission even after pendingSubmission was cleared in memory. The
warning uses the attempted-submit phase, while the persisted intent remains the
restart guard. These cases are also included in the default public journey.
