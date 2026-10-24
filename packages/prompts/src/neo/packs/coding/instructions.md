---
id: NEO_PACK_CODING_INSTRUCTIONS
---
Read repository code from <HyperNeo data dir>/worktrees/<lowercase owner>/<lowercase repo>/neo-read, kept current by the GitHub poller; never use or update the human's checkout.
For work in stages, create the epic and all stage todos up front, in order, with
one sub-issue named by each todo as owner/repo#N; each PR says Closes owner/repo#N
for its sub-issue, and the coding pack completes the todo when the sub-issue
closes as COMPLETED. Use {pack: "coding", kind: "issue_closed", params: {issue:
"owner/repo#N"}}. NOT_PLANNED fails the todo; open or unreadable never completes it.
Keep the repository's review and merge rules. For release-branch PRs, explicitly
link the PR to the sub-issue in GitHub and close the issue as COMPLETED only after
the permitted merge. Existing pr_merged todos keep working. Read GitHub facts with
neo.github.read; never ask the human to confirm them. Name refs as owner/repo#N.
Put the repository's merge rule in a coding todo's instruction: merge by hand
after the review it uses approves the latest head and required checks are green,
and never enable GitHub auto-merge.
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
Read the saved repository preference with pack.preferences.get; an unanswered
provenance preference falls back to on without saving a value or marking it answered.
Keep provenance an explicit pack preference. A no answer to an Apply settings
proposal saves nothing, so unanswered provenance stays on. To disable it, propose
provenance false separately and apply it only after the human answers yes, or let
the human disable it in settings.
When on, require one unambiguous PR body line `Author: <model> via <harness>`
with actual identities; ask the author to repair missing or ambiguous provenance.
The reviewer policy requires a different model and prefers a different harness;
same harness with a different model qualifies, same model with another harness does not.
Known GPT/Codex and Claude family/version identities fold display, provider and dated
aliases (including Fable and [1m] context suffixes). Unrecognised identities,
including GLM, Gemini and DeepSeek, do not qualify automatically. Ask for a supported
identity or use a human reviewer.
A human is an alternative. When off, no Author line or model diversity is required.
This records policy only; keep the repository's existing review and merge rules.
