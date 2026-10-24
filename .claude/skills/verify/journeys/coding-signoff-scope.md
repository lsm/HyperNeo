### Scoped signoff and terminal owner delivery

```bash
RUN=$(mktemp -d /private/tmp/hn-signoff-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/coding-signoff-scope.ts "$RUN"
```

The helper starts a real isolated daemon on an ephemeral port with a fresh synthetic
DB. It sets repo preferences through RPC and runs production coding-pack sweeps
against synthetic GitHub responses. Exact-head bot approval and green CI must
move a code-only PR to `approved_green` while a design PR stays `waiting_human`.
The worker's real durable mailbox must receive one merge instruction, one merged
notice and one closed notice; another identical read must add nothing. The daemon
snapshot, ledger and mailbox payloads are retained in `evidence/signoff-scope.json`.
On the reproduction commit, the code PR incorrectly waits for a human and neither
terminal event arrives. Every run shuts down its daemon and socket in `finally`.

No network, credentials, provider turns or real DB are used. Mailbox acceptance is
verified; model consumption and live GitHub transport are not. Incomplete changed
file lists must keep signoff pending, covered by synthetic ledger unit tests.
