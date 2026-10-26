# One Neo input per worker turn

Use SKILL.md's shared isolation and metadata-only proof wrapper. No provider,
HTTP model mock, GUI or live GitHub access is needed. Check memory pressure
first (at least 25% free); the wrapper checks at least 25 GiB disk space.

```bash
TMPDIR=<existing-writable-temp-dir> bash .claude/skills/verify/proof-run.sh \
  <absolute-fresh-evidence-dir> .claude/skills/verify/worker-turn-delivery.ts verify
```

The helper owns a real daemon on an ephemeral non-8399 port, a disposable home
and database, and a refusing gh executable. Two synthetic workers each bind to
two coding todos. One worker sends a structured milestone through the real
message.send RPC before its terminal SDK record. The other ends without a send.
Run the actual driver-refresh job twice and inspect Neo's stored incoming SDK
messages. The explicit sender must yield one session message and zero turn-report
inputs; the other must yield one turn-report input. Both todos record the complete
receipt-bound final report and remain doing, awaiting coding facts. Baseline `before` mode
on the test-only commit observes two turn reports for each worker instead.

The status-drift case first binds one todo and delivers its completed turn while
the worker is done, then binds a second todo while that same worker is running.
Both first observations of the old turn must share one delivery receipt. A final
refresh while done must retain the complete report on both todos. On the
pre-review-fix head, `status-before` mode reproduces two delivered reports with
different statuses. `firstStatus` and `secondStatus` preserve the real work.status
RPC results alongside the actual recipient inputs.
Each scenario then exposes an unchanged report under a new terminal record ID.
No additional input may reach Neo; preserve the per-scenario replay counts.

Evidence is observed.json with all recipient input bytes, send receipt, counts
and todo records. This proves daemon receipt/storage, not model consumption or
GUI rendering. The wrapper preserves evidence and removes synthetic daemon data.

## Remote sender identities

The helper also owns an ephemeral loopback work.status peer whose source machine
differs from the local attachment alias. For HyperNeo, Codex and Claude Code refs,
the real remote-send forwarder submits an explicit report through Neo's actual
RPC door. The report's recorded from_session must retain the source machine and
native adapter prefix. Neo's real driver-refresh job must suppress the separate
turn report for that same sender. The status peer is synthetic; native worker
execution is not claimed. The helper detaches and stops both owned connections.

On the pre-sender-fix head, `sender-before` mode observes one extra turn report
for each of the three remote senders. In `verify` mode all three have zero extra
reports. Preserve the remote status replies, recorded sender IDs, send receipts
and incoming report bytes. Unit contracts also cover local native sender IDs and
prove that the same session ID on another source machine does not suppress a
new report. Missing source-machine metadata retains the older exact attachment
lookup and never performs a suffix-only match.
