# Coding pack: write → review → verify

Proposed; docs only until human approval. Each coding task has three distinct
roles and one acceptance contract, derived from the human's words **before work
starts**: quoted request, numbered “done means” criteria, allowed scope and key
flows. Clarify missing criteria before dispatch; the author cannot broaden them.

## Three actors

| Step | Actor | Required result |
| --- | --- | --- |
| Write | Worker session | Implements the task, maintains the repo's verify skill, opens the PR and addresses findings. Its own verification helps but cannot approve Verify. |
| Review | Configured repo review bot; otherwise a fresh review session, or a human | A soundness verdict covering every required review-contract dimension, with explicit bug/integration and goal/scope passes. Static review does not replace running the change. |
| Verify | Independent session, distinct from both author and reviewer | Evidence answering “did this do what the human asked?” and “did it change anything else?” Never the author reviewing its own report. |

Review routing is a coding-pack code decision keyed only on whether the repository
has a review bot configured. When configured, that bot's approval on the exact
latest PR head **is the review stage**; never open a separate reviewer session,
including while approval is missing, stale or negative. When no review bot is
configured, open a separate reviewer session, or use a human reviewer. Bot and
repository names are not routing rules. Actor assignment and merge gates reuse this decision.

Each repository has one unified preference set with the same shape for Write,
Review and Verify: preferred harness, model and effort (thinking level) per stage.
All are preferences: when unavailable, fall back to the default and say why.
Review preferences do not apply when a review bot is configured.

Provenance is a coding-pack preference, **on by default**, user-disableable.
Use the existing first-use preference question; until answered, explicitly fall
back to on without storing a value or marking the preference answered. When on,
require `Agent: <model> via <harness>` with actual identity; ask the author to fix
missing/ambiguous provenance before assigning review. For the no-bot reviewer
session, require a **different model** and prefer a different harness too (for
example Codex CLI reviewing Claude Code). Fallback: same harness, different model.
Same model/different harness cannot qualify. Record reviewer identity; a human is
an alternative when no review bot is configured. Unavailable qualifying alternatives
block for configuration. Provenance does not add
a reviewer session alongside a configured bot. When off, no Agent line is required
and reviewer diversity is not enforced. Repo review/sign-off rules remain mandatory.

## Verify

An independent session pins the PR's latest head, uses the repository's verify
skill to really run the change in an isolated environment, and checks each
acceptance criterion with evidence. Missing or uncertain evidence is not a pass.

## Recorded gates and completion

Attach Review and Verify facts to the existing PR/todo ledger: PR identity, exact
head, actor identity, verdict, acceptance-contract reference and durable evidence
links (CI/run/artifact identifiers). The pack reads the actual review verdict and
Verify artifacts; an author's “done” message or a link without results cannot open the gate.
A new push invalidates **both** approvals. Verify is bound to the PR head only; CI covers
integration with the base. This explicitly proposes replacing the reused Verify
contract's base-integration and base-advance revalidation rules for coding-pack
runs; align that contract before wiring this pipeline. A rebase changes the head
and reruns Verify.

Merge requires matching-head passing Review and Verify, green required CI, resolved
findings and any repository human sign-off. Re-read the head immediately before
the repository-authorized, SHA-pinned manual merge; never enable auto-merge.
After deployment, confirm the running build contains the merge and have the
Verify session run one smoke check of the changed behavior, recording build and result. A failed
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
and [Verify](../../packages/prompts/src/agents/system-contracts/qa-system-contract.md)
contracts, and the repo's [verify skill](../../.claude/skills/verify/SKILL.md).
Implementation follows approval in small PRs: pin existing behavior; add stage
facts/provenance policy; wire actor assignment and merge/completion gates.
