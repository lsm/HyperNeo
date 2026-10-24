# Coding pack: write → review → verify

Proposed; docs only until human approval. Each coding task has three distinct
actors and one acceptance contract, derived from the human's words **before work
starts**: quoted request, numbered “done means” criteria, allowed scope and key
flows. Clarify missing criteria before dispatch; the author cannot broaden them.

## Three actors

| Step | Actor | Required result |
| --- | --- | --- |
| Write | Worker session | Implements the task, maintains the repo's verify skill, opens the PR and addresses findings. Its own verification helps but cannot approve QA. |
| Review | Repo review bot, otherwise a fresh review session, or a human | A code-soundness verdict. Reuse the review contract's two lenses: one pass hunting bugs/integration risks, one checking scope against the request. Static review does not replace running the change. |
| Verify | Independent session, distinct from both author and reviewer | Evidence answering “did this do what the human asked?” and “did it change anything else?” Never the author reviewing its own report. |

Every PR description includes `Author: <model> via <harness>` with the actual
model and harness (for example Claude Code, Codex or HyperNeo). The coding pack
reads it before assigning review. Missing or ambiguous provenance asks the author
to correct the description; it does not guess. A pack preference, **on by default**,
requires an AI reviewer with a different model **and/or** harness from the author;
a fresh session alone is insufficient. Record the reviewer's actual identity too.
A human reviewer is an independent alternative. If a required repo bot cannot
satisfy diversity, retain its required approval and add a qualifying reviewer.
Unavailable alternatives block for configuration rather than silently disabling
the preference. Existing repository review/sign-off rules remain mandatory.

## Independent QA

QA pins the candidate head and base, then reuses the repo's existing verify skill
(including scripts and journeys) in its own isolated checkout. Run the actual
changed behavior against every acceptance criterion. For daemon work use
`NODE_ENV=test`, a private synthetic data directory/database, separate ports and
mock endpoints, with no real keys or production data. Record inputs, commands,
outputs, test results, screenshots where applicable and pass/fail per criterion.
Missing or inconclusive evidence is not a pass.

UI changes require the real browser or Simulator and screenshots of the relevant
states; unit tests alone never pass UI QA. Tests driving a real GUI must never
run unattended on the human's own machine: use an isolated CI/test machine or an
attended run. If neither is available, mark QA blocked. Stop test resources.

For scope, compare the entire diff with the allowed scope, run key flows on both
the base and candidate, and record unexpected changes. Require full-suite results
for the exact candidate: reuse a complete CI run, or run uncovered suites in the
isolated environment. Baseline failures stay explicit and do not become a green
result. Necessary extra scope returns to the human before implementation; QA
does not authorize it. Findings go to the author with reproducible evidence.

## Recorded gates and completion

Attach review and QA facts to the existing PR/todo ledger: PR identity, exact
head, actor identity, verdict, acceptance-contract reference and durable evidence
links (CI/run/artifact identifiers). QA also records its tested base/integration
commit. The pack reads the actual review verdict and QA artifacts; an author's
“done” message or a link without results cannot open the gate. A new push
invalidates **both** approvals. A base advance requires QA to revalidate the
candidate's integration before merging.

Merge requires matching-head passing review and QA, green required CI, resolved
findings and any repository human sign-off. Re-read the head immediately before
the repository-authorized, SHA-pinned manual merge; never enable auto-merge.
After deployment, confirm the running build contains the merge and have QA run
one smoke check of the changed behavior, recording build and result. A failed
smoke keeps the task open. Non-deployable changes record why smoke is inapplicable.

Keep one coding todo/sub-issue per existing work slice, with linked write,
review and verify assignments and recorded stage outcomes; do not create another
workflow engine. Replace merge/issue-closure-only completion with **gated merge
plus deployment smoke** (or recorded inapplicability). GitHub may auto-close the
sub-issue on merge; CLOSED/COMPLETED is required but cannot complete the todo
without those facts. Keep the todo pending through smoke. The parent work completes
only when its existing sub-issues meet this rule. Apply it to newly dispatched
work; preserve historical outcomes.

Reuse [pack policy](../../packages/daemon/src/lib/neo/packs/coding/pack.ts),
[verify preflight](../../packages/daemon/src/lib/neo/packs/coding/prepare-execution.ts),
[PR facts](../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts),
[todo checks](../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts),
[deployment ancestry](../../packages/daemon/src/lib/neo/packs/coding/deploy-checks.ts),
the [review](../../packages/prompts/src/agents/system-contracts/reviewer-system-contract.md)
and [QA](../../packages/prompts/src/agents/system-contracts/qa-system-contract.md)
contracts, and the repo's [verify skill](../../.claude/skills/verify/SKILL.md).
Implementation follows approval in small PRs: pin existing behavior; add stage
facts/provenance policy; wire actor assignment and merge/completion gates.
