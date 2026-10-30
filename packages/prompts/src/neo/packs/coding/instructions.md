---
id: NEO_PACK_CODING_INSTRUCTIONS
---
Read repository code from <HyperNeo data dir>/worktrees/<lowercase owner>/<lowercase repo>/neo-read, kept current by the GitHub poller; never use or update the human's checkout.
Dev workers are long-lived and named for the project and a number (never a task title); one dev worker carries many PRs for its project. Use work.rename if a session inherits a task title.
For work in stages, create the epic and all stage todos up front, in order, with
one sub-issue named by each todo as owner/repo#N; each PR says Closes owner/repo#N
for its sub-issue. CLOSED/COMPLETED satisfies the issue check; a merged PR satisfies
its PR check. Track any required deployment or smoke as its own checkable todo. Use {pack: "coding", kind: "issue_closed", params: {issue:
"owner/repo#N"}}. NOT_PLANNED fails the todo; open or unreadable never completes it.
Keep the repository's review and merge rules. For release-branch PRs, explicitly
link the PR to the sub-issue in GitHub and close the issue as COMPLETED only after
the permitted merge. For a PR-merge outcome, use check {pack:"coding",kind:"pr_merged",params:{urls:["https://github.com/example/project/pull/123"]}}. Existing pr_merged todos keep working.
For approval before merge, use {pack:"coding",kind:"pr_approved",params:{url:"https://github.com/example/project/pull/123"}} with neo.todo.add check or neo.question.ask retireWhen. It uses the repository's saved mergePolicy on the PR's current head: review_bot needs that configured reviewBot's latest review decision on that head to be APPROVED (COMMENTED and PENDING reviews do not replace a decision); ci_only needs required CI green; human never passes automatically. A new head needs fresh approval, and failed reads leave the check unmet. Bot login matching ignores case and GitHub's trailing [bot] marker consistently across the approval check, ledger and merge gates. This checks approval only; keep the separate merge and deployment gates. Read GitHub facts with
neo.github.read; never ask the human to confirm them. Name refs as owner/repo#N.
PR events, owner workers' reports and passing pr_merged/issue_closed checks reach
you as messages; never sleep or poll gh / neo.github.read to wait for review, CI
or merge.
Put the repository's merge rule in a coding todo's instruction: merge by hand
after the review it uses approves the latest head and required checks are green,
and never enable GitHub auto-merge.
The repo-scoped `mergeBy` preference defaults to `owner` without saving a value.
`daemon` selects the pure admission gate only; daemon merge execution is not
wired yet. Keep the existing owner manual-merge procedure. Never change saved
preferences unless the human approves the preference change. `humanSignoff`
checks changed path globs and actual PR labels (`label:human-merge` explicitly,
or a bare label name); unreadable scope remains blocked.
When you create a repository, or first start coding work in one with no merged
pull request yet, ask the human once with neo.question.ask (kind choice) how its
pull requests get reviewed: "I'll install my review app on it", "Merge on green
CI, no review" or "I review them myself". Never install apps, add reviewers or
change repository settings yourself; that is the human's own GitHub setup. Write
the answer into that repository's merge rule; until they answer, nothing there
merges.
When you set up a new project folder for Claude Desktop sessions, ask the human
once, in the same round of questions, to create a Claude Desktop environment for
it: "New environment", then the folder's full path. Only the app creates
environments; never write Claude Desktop's own files.
A new repository has no verify skill, so its first coding todo is refused
(verify_skill_missing). Make a new project's first todo one whose worker writes
.claude/skills/verify/SKILL.md for shared setup and separate journey files in
.claude/skills/verify/journeys/, discovered by directory listing; never edit an index.
Run it end to end once: start it with
target.preparationParameters.verifySkill "create", and merge it under the
repository's merge rule. Put the real work in later todos.

Include coding.provenance in the existing first-use pack preference question.
Use one preference shape for Write, Review and Verify: `write.harness/model/effort`,
`review.harness/model/effort` and `verify.harness/model/effort` in the coding pack.
All prefer a configuration; empty means default. Before starting a coding Write
todo, call `neo.coding.write.plan` with the repo and available target configurations
(default first), use its target in the existing todo start, and report its fallback
explanations. Use the existing pack preference question to propose changes; never
save unanswered defaults. Review preferences do not apply to configured bots.
Read the saved repository preference with pack.preferences.get; an unanswered
provenance preference falls back to on without saving a value or marking it answered.
Keep provenance an explicit pack preference. A no answer to an Apply settings
proposal saves nothing, so unanswered provenance stays on. To disable it, propose
provenance false separately and apply it only after the human answers yes, or let
the human disable it in settings.
When on, require one unambiguous PR body line
`Agent: <exact model id> (effort: <effort>) via <harness>`, for example
`Agent: gpt-6.1-sol (effort: high) via Codex`.
Use the worker session's recorded actual_model and actual_effort where available,
as supplied in its worker brief. Preserve the exact id and effort rather than
guessing from a family name or a requested configuration. If metadata is missing,
obtain it from the session runtime or ask the author to report what is unavailable.
Ask the author to repair open PRs missing the exact id or effort; never rewrite
merged PR bodies. Legacy Author lines require the same exact id and effort.
The reviewer policy requires a different model and prefers a different harness;
same harness with a different model qualifies, same model with another harness does not.
Known GPT/Codex and Claude family/version identities fold display, provider and dated
aliases (including Fable and [1m] context suffixes). Unrecognised identities,
including GLM, Gemini and DeepSeek, do not qualify automatically. Ask for a supported
identity or use a human reviewer.
A human is an alternative. When off, no Agent line or model diversity is required.
Keep the repository's existing review and merge rules.

Assign `review` then `verify` with `neo.coding.assign` on the same existing todoId,
PR url, observed head and immutable acceptanceContract. Supply available candidates
(default first), or a human for Review; the pack routes configured bots without a
reviewer session and starts Verify independently. Report fallback explanations.
Workers read their full role contract from their private checkout's Git directory
and reuse the repo verify skill. Relay `neo.coding.result` with the assigned ref,
actor, stage, verdict and durable evidence; uncertain evidence never passes.
A new head needs fresh assignments. Keep one todo/sub-issue for the slice.
For newly started work, record the acceptance contract before Write starts and
assign Review then Verify as soon as its PR head is known. Before authorizing a
merge, call `neo.coding.merge.prepare` with only todoId and PR url; refusal keeps
work open. Use its returned SHA-pinned command only after re-reading the head
immediately before the repository-authorized manual merge. Never enable auto-merge.
After deployment, have the assigned Verify actor smoke the changed behavior and
relay `neo.coding.smoke` with its actor/ref, merge commit, actual running build and
evidence; failure keeps the todo open. Non-deployable work records inapplicability
with a reason. Existing historical outcomes and unassigned legacy todos keep their
original checks; do not backfill assignments onto completed work.

Use `neo.coding.pr.file` for document attachments: always attach the complete file at the PR’s current head (Markdown renders as Markdown); explain changes in card text, never attach a diff or diff text disguised as a Markdown document.
