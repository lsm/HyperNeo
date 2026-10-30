# Daemon merge execution in the coding sweep

Use the guarded metadata-only wrapper from SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-daemon-merge-sweep.ts
```

Add `enterprise` after the helper path to repeat with synthetic `GH_HOST`;
required Deno smoke repeats every variant. Reads and the merge command must target
that host, while the default remains github.com. The unit regression supplies
a matching public PR on the same head and proves it is never selected.

The helper owns a real isolated daemon and ephemeral listener, disposable HOME and
database, and a synthetic GitHub CLI. External HTTP is refused; no provider is
used. Synthetic preferences are set through the public operation RPC. It calls
the production coding pack sweep, including ledger reconciliation and the actual
merge CLI effect, without a todo or owner.

A sign-off label on a later page must hold for the human. A rejected sign-off
notification must let the full pack sweep finish and retry next time. Changing
only synthetic policy to human must put the PR in waiting_human and wake Neo
without a merge or preference writes by the daemon. Every required GitHub
read failure and a changed final head must leave the PR unmerged with no attempt
receipt. A passing synthetic PR must execute exactly one squash command pinned
to its full head SHA and persist executor, head, confirmation time and commit.
Refused delivery must retain the receipt; later successful delivery to Neo must
acknowledge it without repeating the merge. The pack's human merge operation
adds/removes its label for explicit human intent. The owner default and all
preferences captured before execution must remain unchanged.

The unit contracts additionally cover overlapping sweep invocations, every gate,
open/moved reserved attempts and recovering a successful merge whose first
confirmation read failed. Build-slice proof covers durable receipts across daemon
restart. At-most-once reservations deliberately do not retry an uncertain open
attempt; readable held receipts notify the owner or Neo, with a distinct merged notice later.

The helper saves coding-daemon-merge-sweep.json and the exact CLI invocation log,
stops its daemon and preserves evidence before the wrapper removes synthetic data.
No GUI, live GitHub merge or installed daemon deployment is exercised.

Add `policy-revoke` after the helper path to change mergeBy to owner through the
real preference RPC during GitHub checks; final admission must issue no merge.
The final-read/API-call interval and in-flight writers remain an explicitly
accepted limitation pending [#9458](https://github.com/lsm/HyperNeo/issues/9458).

Add `merge-fails` to prove a failed CLI attempt stays OPEN, surfaces its held receipt
on delivery recovery, and is not retried. Unreadable facts still halt the sweep.

Add `late-label` to add human-merge after the batch snapshot; post-reservation reads must hold it.
