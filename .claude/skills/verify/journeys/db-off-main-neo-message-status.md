# Neo message-status facts use the shared read worker

Read shared SKILL.md and neo-daemon-message-status.md. No model, GUI, real GitHub,
credential file, real DB copy, live mutation or port8399. Suites stay CI-only.

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-status-reader-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/neo-message-status-reader.ts verify "$RUN"
```

Use `baseline` before production changes. Repeat with `VERIFY_NATIVE_WAIT_MS=0`
for natural query/RPC measurements, separately from the default controlled1200ms
native wait at the target statement call. That injected native wait models a
stalled synchronous call; it is NOT physical disk latency or proof of the kernel
cause of production off-CPU time. SQL text/fingerprint remains unchanged. The
main target call wall time includes the injection; actual observed SQL timing
and worker request timing are separate. Report every250ms RPC/query miss.

The helper owns a real daemon, public neo.conversation.asks.read and
neo.conversation.read RPCs and an independent health process. It seeds100 large SDK
rows (~239MB logical bodies) through production writers, durable asks/publications through their repos,
all six statuses plus legacy-null status, exact active ownership and a foreign
reply that must not answer. Only the legacy-null status field is adjusted after
a production write. An entire tool result and every logical SDK body are hashed
before/after; complete human content, identities and status order must match.

Repeat with `VERIFY_STATUS_IPC=1` for the real native Bun worker behind the
Node-hosted test IPC seam. A proof-only fixture startup buffer waits for its
instrumentation module before forwarding the command; it never fabricates a
read reply or replays one. `VERIFY_STATUS_MEMORY=1 VERIFY_NATIVE_WAIT_MS=0`
checks the explicit no-disk configuration with32 history rows. Never call a
file-backed worker failure a reason to fall back to main SQLite.

`evidence/status.json` retains response latency, max main lag, independent
health latency, main target calls, forwarded SQL/request spans, argument cloning,
RSS, WAL bytes and complete body hashes. Seeding/hash audits are outside the
measurement interval. It closes its socket, probe, workers and daemon in finally.
After deployment, confirm build with hyperneo build and read-only performance
logs grouped by commit/PID; missing samples remain inconclusive.

Before seeding the large fixture, the empty synthetic daemon finishes its initial
body copy. New production dual-writes in that same process then retain nonempty
legacy bodies, a supported coexistence shape; no marker is forged and no stored
body is removed. Ninety durable visible asks stay within the public100-row page
bounds. Both readers serve the existing normalized text-block content exactly.
The initial helper attempts used the wrong body-column name/content shape and
are retained as inconclusive, not performance evidence.
