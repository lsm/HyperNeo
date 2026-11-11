# Every worker turn report identifies its worker

Follow SKILL.md for the pinned runtime, resource check and isolated proof wrapper.
Run from the checkout root with a fresh absolute evidence directory.

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/worker-report-identity.ts
```

The helper owns a test daemon on an ephemeral loopback port, a fresh HOME/data/DB,
and a refusing GitHub stub. Its synthetic worker has a recorded notice dispatch
without a todo. The worker ends with an empty result while its status is running.
The real driver-refresh job must deliver exactly one input to Neo containing the
worker name, full hyperneo-prefixed session ref, known link and no-reply fallback.
A second refresh must retain one report. The wrapper preserves observed.json and
proof.log and removes synthetic daemon data after cleanup.

Before the fix the received report lacks the worker name and ref, so the identity
assertion fails. Focused runner contracts cover full Codex, Claude and HyperNeo
refs across todo, notice, focused-discussion and human-directed reports. Those
contracts use synthetic driver outcomes. This journey observes actual recipient
SDK input bytes through the local HyperNeo adapter and RPC door.

The runner contracts also require a validated HTTPS remote bridge to take
precedence over relative or native links. A daemon-qualified relative link
without a bridge and unsafe URLs are omitted. Local HyperNeo paths remain
available. Link validation reuses neoSafeSessionLink.
