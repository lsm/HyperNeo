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

Evidence is observed.json with all recipient input bytes, send receipt, counts
and todo records. This proves daemon receipt/storage, not model consumption or
GUI rendering. The wrapper preserves evidence and removes synthetic daemon data.
