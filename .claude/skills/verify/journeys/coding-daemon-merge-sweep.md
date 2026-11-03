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

Add `zero-required` to reproduce repositories whose reported CI is not required.
The fake CLI must return exit 1, empty stdout, and the exact
`no required checks reported on the 'fixture' branch` stderr. The real facts
reader and pack sweep must issue one SHA-pinned squash and one confirmation,
preserve preferences, and never repeat the command on the next sweep. Unit
regressions cover both owned and unowned PRs, failed/pending required CI, and
refuse empty/ambiguous output, auth/network errors, wrong exit codes and bad JSON.

This diagnostic was reproduced with real GitHub CLI 2.102.0: single quotes,
no `gh:` prefix, empty stdout and exit 1; only the branch name is synthetic.
Do not infer its format from unrelated HTTP/authentication error diagnostics.

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

Add `no-checks` to cover repositories with no CI at all. The fake CLI returns
exit 1, empty stdout and exactly `no checks reported on the 'fixture' branch`
on stderr. Before admitting that empty required set, the real daemon sweep must
hold HTTP 502 and 504 failures with no attempt receipt or merge command. After
restoring the exact no-checks response, it must merge once with the full pinned
head and persist the daemon receipt, without changing saved preferences.
Both no-checks diagnostics still require exit 1 and empty stdout; extra error
lines, wrong exit codes, invalid JSON, auth errors and timeouts remain unreadable.


Add `human-default`, `human-owner` and `human-unconfigured` for the zero-required-check
human handoff. Each boots an isolated daemon, uses a synthetic public conversation
and reads the actual notice through `neo.publication.read`. First discovery with
no owner, an owned PR with owner execution, and an unconfigured repository must
all remain unmerged and visibly wait for the human. A failed delivery is retried
through a recreated pack; the persisted publication appears once, survives repeated
sweeps and does not change preferences. A global allowNoChecksMerge value must not
authorize any repository. Only a subsequent explicit synthetic repo opt-in (with
ci_only and daemon execution) restores exactly one SHA-pinned merge. No actual
GitHub call, live database, provider or browser is used. Human notification is a
persisted conversation message with the PR URL and manual next step, not an
approval card or permission for an agent to merge. Existing required-check and
same-head bot gates remain in the build and sweep journeys. Handoff-state and
publication writes are forbidden on the main-thread DB facade during the proof;
they must run through the existing writer gateway.


Add `approved-no-checks` for a bot-approved PR whose ledger still says
approved_pending because a check suite exists but no status rollup does. It must
reach the fresh required-check reader; a known empty set plus current-head bot
approval must execute one pinned squash, persist the daemon receipt and never
repeat the command. Pending required CI, unreadable checks and an old-head bot
review remain held. The pending-ledger exception admits only a known zero required
count; it does not substitute cached review/CI or promote pending nonempty CI.


Add `human-waiting-ci` and `human-sibling-ci` to repeat the human-visible handoff
with an initially waiting_ci ledger: the PR has a non-required check suite, or
another open PR has CI while this one has none. Both must reach fresh zero-required
facts, show waiting_human and the durable public notice, then merge once only after
explicit repo opt-in. The fresh zero-count exception does not admit nonempty CI
from a waiting ledger. It keeps missing/old bot approval, pending checks, read
failures, human sign-off labels and unresolved threads blocked.


Add `owner-ci` for an owner-execution PR with a nonempty passing required set.
Fresh facts still evaluate whether human handoff is needed, then owner execution
must stop before the daemon merge-attempt pipeline. Repeated sweeps must issue no
merge, reserve no receipt and produce no merge_by_owner warning. Existing human-owner
proofs continue to require the visible zero-check handoff.
