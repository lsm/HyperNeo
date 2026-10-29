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
Switching to a `label:needs-human` rule must let the PR with a complete empty
label list stay `approved_green`, while a PR carrying that label waits for a
human. The ledger used to hold both merely because a label rule was configured.
The helper explicitly saves synthetic watches and awaits session observations;
otherwise today's empty default watch list makes the old journey inconclusive.

It also exercises `mergeBy` through the public preference RPCs: unanswered stays
unsaved and defaults to owner, invalid values are refused, and daemon reads back.
The coding pack's pure admission gate admits an unowned eligible PR, skips owner
execution, stale CI and unresolved threads, reports GitHub read failure and
requires human sign-off for human policy. The synthetic ledger heads cannot pass fresh execution admission; no merge
command is invoked. Complete chronological review facts and required-check/thread
observations must belong to the current head; incomplete reads use read_failure.
Unit contracts cover stale/wrong/revoked bot approval and label/path matching.

With daemon execution selected, the worker receives no approved-green merge
instruction. Its real durable mailbox must receive one merged notice and one
closed notice; another identical read must add nothing. The daemon
snapshot, ledger and mailbox payloads are retained in `evidence/signoff-scope.json`.
On the reproduction commit, the code PR incorrectly waits for a human and neither
terminal event arrives. Every run shuts down its daemon and socket in `finally`.

Required Deno smoke repeats this helper. Local Deno remains unverified when
not installed.

No network, credentials, provider turns or real DB are used. Mailbox acceptance is
verified; model consumption and live GitHub transport are not. Incomplete changed
file lists must keep signoff pending, covered by synthetic ledger unit tests.
