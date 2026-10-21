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

Real CLI 1.0.83 / SDK 1.0.13 compatibility, real queue scheduling/resume behavior,
real account quotas/cost, Desktop/IDE visibility, tool execution and process-tree
containment remain unverified. The fixture impersonates the pinned CLI and
implements only its synthetic protocol. Tools remain unavailable and permissions
reject on create and resume. No arbitrary external or unfinished session is
loaded. Receipt files intentionally retain durable evidence; bounded history
listing/retention policy and owned work.find overlay belong to slice 5.
