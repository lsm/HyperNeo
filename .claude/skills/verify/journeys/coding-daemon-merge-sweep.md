# Daemon merge execution in the coding sweep

Use the guarded metadata-only wrapper from SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-daemon-merge-sweep.ts
```

Reads and the merge command must target that host, while the default remains github.com.
The unit regression supplies a matching public PR on the same head and proves it is never
selected.

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

Add `ci-startup-queued` and `ci-startup-running` for the #9623/#9625 failure:
the required aggregate check has not appeared, so the CLI returns exit 1, empty
stdout and the owner's exact `no required checks reported` diagnostic while
GitHub's commit state is BLOCKED. Across repeated pack recreation, no merge or
failure charge may occur. Once CI and the commit status are green, exactly one
pinned merge and confirmation must occur. Add `ci-merge-race` to make a new pending
run appear during an attempted merge: its readable OPEN confirmation releases the
receipt without charging a failure, and the later green turn merges normally.

Add `ci-retry-budget` for Neo's stopped-report acceptance path. Workers, another
head, pending CI, a human label and unreadable reviews must not reopen the budget.
The exact ready head may be acknowledged once through neo.coding.merge.retry;
historical failures remain unchanged and the daemon, not that operation, merges.
A per-head retry acknowledgement is stored independently of transient merge
receipts, whose notice rows have a cascading foreign key. It survives receipt
release. Unit coverage verifies that the next episode still stops at three,
including timestamp zero and an acknowledgement made after a clock rollback.
The retry-budget helper uses the real Neo mailbox with its processor stopped:
after an explicit retry and another genuine three-failure stop, two distinct
stopped reports must be queued for Neo. Repeated sweeps add neither duplicate
report nor merge. This proves delivery acceptance, not model consumption.
Add `ci-stopped-ready` for an owned, budget-exhausted PR whose CI later turns
green. A fresh-gate read failure must send no ready cue. After every gate passes,
the real Neo mailbox must receive one actionable `neo.coding.merge.retry` cue,
including after pack recreation. The stopped budget remains closed until Neo
acknowledges it; the worker receives no manual-merge instruction. That explicit
acknowledgement then permits exactly one daemon merge. Earlier stop delivery is
not treated as notice of the later green transition.
When adding a Neo operation, also run `tests/unit/1-core/operations/neo.test.ts`
with the shared isolated unit setup. Its advertised-tool catalog must include the
new tool while retaining the existing bound-session authorization assertions.
Also run `tests/unit/1-core/operations/input-examples.test.ts` and the
`operation-input-examples` journey: the exact-head retry schema needs a declared
valid URL and SHA example so MCP invalid-input responses show the next valid shape.

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

Add `large-files` for a 171-file PR whose ledger and `gh pr view` expose only
100 paths. The actual facts reader must paginate filenames-only GraphQL pages and
merge once with the full head. A protected design path on the last page must
hold; missing pages, malformed data and a failed files read must also hold.
No policy changes or manual merge are used to complete the scope.
Ordinary waiting_human rows remain signaling-only. This exception requires a
truncated file summary plus complete current scope and passing fresh gates.

The file read pins both head and base SHA before/after pagination. A moving base
with an unchanged head, or repeated pages whose count looks complete, must hold.
The accepted final-read-to-merge race in #9458 remains unchanged.
A completed scope also needs GitHub's passing commit status (CLEAN/HAS_HOOKS),
not only passing required checks. UNSTABLE, BLOCKED and UNKNOWN must hold.

File pages contain paths and snapshot metadata, never patches. The 1 MiB output
bound remains; oversized patch fixtures must not be downloaded by this reader.

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

After delivery, try changed wording with the same publication identity. The
immutable-publication conflict must leave the original human-visible handoff
readable and unchanged, without another notification. Recreating the pack and
running the normal sweep must still preserve exactly that one notice. A false
append result does not remove an already-delivered publication; changing an
existing notice would require the publication's explicit edit/correction path.


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
The owner-ci proof also checks the actual CLI log: each sweep must run only its
required-check probe, not reviews, labels, files, threads or head reads. An owner
with explicit zero-check opt-in has neither a handoff nor a daemon merge to do
and makes no merge-facts calls. A known empty required set still triggers full
fresh validation before publishing the human handoff; an unreadable probe stays
held with a human-handoff diagnostic, not a daemon-merge warning. Existing durable
merge receipts retain their full recovery reads even if the executor changes.

Successful handoffs use their existing persisted publication as the per-head
fact; no duplicate hold table or migration is added. After first delivery and
pack recreation, all human variants must make zero additional handoff GitHub
calls for that head, and reconcile must preserve waiting_human and its stateSince. The
non-required-suite and sibling-CI variants exercise the old state flap. Failed
delivery remains retryable. Add `human-new-head` to prove a different head gets
its own fresh validation and notice, while explicit repo opt-in still resumes
daemon merging. A known handoff holds until a new head or relevant policy change;
its cached fact never authorizes an automatic merge. Unit coverage also holds
new acquisitions while reconcile is failed, cooling down or below its quota floor.

Run the `linked-issue` case with the wrapper to exercise the tracker merge gate.
An opted-in repository with no closing reference or a foreign issue reference
must execute zero merges. Closing the mirror early must leave the coding todo
doing. A closing reference to the parent permits one SHA-pinned merge.

The `linked-issue-no-row` case pins fail-open admission for an opted-in PR
whose todo has no stored repository and cannot acquire a mirror row.

The `linked-issue-cross-repo` case keeps the bound mirror in an opted-in
repository while its PR is in a repository with mirroring disabled. The stored
mirror home still controls the closing-reference gate.

Use `assigned-review` or `bot-review-repro` for the actual public bot-then-independent
review path. The public assign operation records bot approval separately. A real
work.send to a synthetic manual-mode session provides an accepted receipt, which
neo.coding.assign records as a pending independent handoff. Two sweeps then emit
no additional sign-off wake. An open human question restores the wake while the
handoff is pending. Resolving it restores coverage; recording the review return
retires coverage and wakes again. Use `bot-review-cancel` for cancellation instead
of return. No held case merges or changes preferences.

The proof rejects the coverage query on the main connection. The registered
SQLite worker owns its SQL. Focused tests preserve missing/stale/unreadable
coverage, unaccepted or uncertain receipts, completed reviews, file sign-off and
explicit human merge policy. Retired handoffs cannot be revived by stale retries.
