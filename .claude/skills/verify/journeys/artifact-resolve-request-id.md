# Artifact resolve retries require a caller-owned request ID (#8006)

Use the SKILL.md metadata-only isolation rules: a fresh absolute RUN under
/private/tmp, NODE_ENV=test, fresh HOME/data/DB, no provider/environment keys.
Do not put its synthetic workspace under .codex or another excluded sensitive
root. Use pinned Bun 1.4.2 on PATH. No model mock, fixed port, or GUI is needed.

```bash
RUN=$(mktemp -d /private/tmp/hn-resolve-id-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test LOG_LEVEL=error \
  HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/preview-resolve-request-id.ts "$RUN"
```

The helper seeds a source-bound synthetic report, owns an ephemeral loopback
daemon, and calls operation.invoke over its real WebSocket RPC door. Two calls
without requestId must fail input validation and create zero immutable receipt
rows. Two calls with the same per-tap requestId must return one identical accepted
receipt and leave exactly one registry row. The actual web resolver then retries
one target object without another receipt, and a distinct tap creates one new
receipt. Its IDs live in a WeakMap keyed by the immutable preview target; they
last across retries and disappear with that target, without mutating UI state. Before the fix the first pair
succeeds with different artifact IDs and leaves two receipts. It reads only the
owned synthetic registry, saves evidence/request-id.json, and closes its socket
and daemon in finally. Keep evidence; no live DB or port 8399 is touched.

Clients must generate one UUID for a new tap and reuse that UUID on retries;
the operation never invents a new retry identity. Existing completed receipts
and snapshots remain untouched; no migration, deletion or cleanup is added.

The web client uses shared generateUUID(), including its plain-HTTP fallback;
exercise artifact-reference-client.test.ts with crypto.randomUUID unavailable.
The retained PR-summary native/RPC and Git-capture helpers now supply stable
fixture UUIDs, including across daemon restart. Their existing journeys remain
valid under the required-input contract.
