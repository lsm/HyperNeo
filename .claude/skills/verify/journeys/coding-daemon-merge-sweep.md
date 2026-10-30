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
restart. Unreadable confirmation retains the receipt and CLI error, even when the command
exits nonzero. Only a readable OPEN result releases/counts the attempt; retries
recheck every gate.
Readable held warnings are durably acknowledged and terminal attempts retire; confirmation stays distinct.

The helper saves coding-daemon-merge-sweep.json and the exact CLI invocation log,
stops its daemon and preserves evidence before the wrapper removes synthetic data.
No GUI, live GitHub merge or installed daemon deployment is exercised.

Add `policy-revoke` after the helper path to change mergeBy to owner through the
real preference RPC during GitHub checks; final admission must issue no merge.
The final-read/API-call interval and in-flight writers remain an explicitly
accepted limitation pending [#9458](https://github.com/lsm/HyperNeo/issues/9458).

Add `merge-fails` to prove failed CLI attempts release their receipts, stop at three
failures per head across pack recreation, and deliver the PR URL, head and last error
to Neo after notification recovery. Unreadable facts hold only their own PR; the sweep logs its URL and read reason and continues.

Add `late-label` to add human-merge after the batch snapshot; it must hold, then resume on label removal.

Add `per-pr` to seed an unreadable first PR and a mergeable sibling. The full pack
sweep must finish, log the failed PR with its read reason, merge only the sibling
with the exact full head, notify Neo, and issue no second merge on the next sweep.
Final admission and confirmation read failures are also isolated per PR; unreadable
receipts remain pending for recovery.

Add `retry-once` to fail the first command with a required-check error, recreate the
pack, then merge on the second sweep. Assert exactly two pinned commands and one
confirmation, and retain the original CLI error in the hold log. `coding-daemon-merge-build.ts`
also checks the durable failure budget through a real daemon restart; its synthetic
writer records are distinct from the sweep's CLI execution proof.

Add `legacy-open` to seed an unfinished receipt from the previous build. With
fresh facts confirming OPEN, the full sweep must release that attempt, consume
one failure from the durable budget and merge through current admission without
a manual receipt edit.

Add `uncertain-error` to apply the synthetic merge, return a CLI error and fail
confirmation reads. The receipt and error must survive without consuming retry
budget. Restore reads and recreate the pack: exactly one confirmation must arrive
without issuing another merge. A separate regression recovers OPEN after an
unreadable third command and requires the original CLI error in Neo's limit notice.

Add `limit-gone` to exhaust retries while Neo delivery is unavailable, close the
PR and switch its policy to owner, then restore delivery. The pending limit
report must still reach Neo exactly once. Add `external-owned` to fail one
attempt and then apply an external merge. The normal ledger MERGED event must
notify the linked owner once; only approved-green manual merge instructions
are suppressed for daemon execution. Terminal fixtures must contain the PR
only in the done connection with a real closedAt value.
