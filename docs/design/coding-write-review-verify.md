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

A coding-pack provenance preference is **on by default**; the user may turn it
off, for example when writing the code themselves. When on, every PR description
includes `Author: <model> via <harness>` with the actual model and harness. The pack
reads it before assigning review; missing or ambiguous provenance asks the author
to correct it rather than guessing. An AI reviewer must use a **different model**;
a different harness is preferred too. Best: both differ (for example a Codex model
via Codex CLI reviewing Claude Code work). Fallback: same harness, different model.
The same model through another harness does not qualify. Record reviewer identity.
A human reviewer is an independent alternative. If a required repo bot cannot
satisfy diversity, retain its approval and add a qualifying reviewer; unavailable
alternatives block for configuration. When the preference is off, no Author line
is required and reviewer diversity is not enforced. Existing repository review
and sign-off rules remain mandatory in either mode.

## Independent QA

QA pins the head and reuses the repo's verify skill (scripts and journeys) in its
own checkout. Check every acceptance criterion by running the changed program in
the isolated environment that skill defines: test configuration, its own synthetic
data, separate ports, mocked external services, no real keys or production data.
Record inputs, commands, outputs, test results, screenshots where applicable and
pass/fail per criterion.
Missing or inconclusive evidence is not a pass.

QA runs autonomously, with no human watching. For UI changes it launches the
platform's simulator or emulator, or an isolated browser profile, performs the
action and checks screenshots (for “remove this button”, open the screen and
confirm it is gone); unit tests alone never pass UI QA. For backend/API changes
it runs the changed service in that isolated environment and calls the changed
API, checking the response.
QA never drives the human's own running apps or signed-in accounts; it uses its own isolated environment.
Stop test resources.

For scope, compare the entire diff with the allowed scope, run key flows on both
the base and candidate, and record unexpected changes. Require full-suite results
for the exact candidate: reuse a complete CI run, or run uncovered suites in the
isolated environment. Baseline failures stay explicit and do not become a green
result. Necessary extra scope returns to the human before implementation; QA
does not authorize it. Findings go to the author with reproducible evidence.

## Recorded gates and completion

Attach review and QA facts to the existing PR/todo ledger: PR identity, exact
head, actor identity, verdict, acceptance-contract reference and durable evidence
links (CI/run/artifact identifiers). The pack reads the actual review verdict and
QA artifacts; an author's “done” message or a link without results cannot open the gate. A new push
invalidates **both** approvals. QA is bound to the PR head only; CI covers
integration with the base. A rebase changes the head and reruns QA.

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
