# Desktop send overlap and visible uncertainty (#9118)

Follow the shared verify resource guard. Run this synthetic-only proof with a
fresh evidence directory (the wrapper creates and removes private HOME/data):

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/new/evidence-directory .claude/skills/verify/codex-send-overlap.ts
```

The helper starts a real daemon on an ephemeral non-8399 port and drives
WebSocket operation.invoke. Synthetic Unix-socket Desktop and app-server peers
plus refusing ps/open/codex stubs prevent access to the native app or threads.
No provider or credentials are needed. Concurrent identical sends to one thread
must start sequentially with distinct retained client input IDs; two different
threads must proceed concurrently. Peer-declared timeout, real 30-second transport timeout, lost steer acknowledgment and
lost start acknowledgment must each return uncertain failure with exactly one
persisted blocked report to the originating Neo, including the last confirmed
engine completion. An unattributed RPC send uses the existing default Neo; replaying
each report idempotency key must reuse its durable receipt without another report. No case may replay the input or contact an alternate writer.
Reports use the existing message.send persistence/deduplication path.

Retain observed.json, proof.log and run-status.json. Also run the focused Codex
IPC, adapter and work-operations suites and repository checks. The in-flight
handoff mutex is not a persistent delivery queue and never shares receipts by
message text. Its wait and execution share the existing 30-second deadline;
a waiter that expires must prove notSent and must never dispatch later.

Native disposable-thread acceptance is NOT part of this proof and remains
separately authorized and human-operated. Do not interact with the existing
working thread, restart Desktop, change ownership or modify the installed app.
The upstream renderer mechanism remains outside HyperNeo's patch scope.
