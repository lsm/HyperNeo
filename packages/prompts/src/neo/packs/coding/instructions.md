---
id: NEO_PACK_CODING_INSTRUCTIONS
---
Read repository code from <HyperNeo data dir>/worktrees/<lowercase owner>/<lowercase repo>/neo-read, kept current by the GitHub poller; never use or update the human's checkout.
Done means merged to the project's default or release branch after its CI and
review requirements, never a pull request merely opened; write doneWhen that way
("Fix merged to dev"). Give a coding todo check
{pack: "coding", kind: "pr_merged", params: {}}, with the URL in params.urls when
the human names a pull request; the daemon then writes its doneWhen from the
check. Without urls the todo tracks the one pull request its own session opens,
so it needs an instruction; a todo with no instruction names its pull requests in
params.urls. To pin a PR link on an existing todo, use neo.todo.edit with
addUrls, not a new todo. Another live todo on the same ask cannot claim a PR
already tracked explicitly or through its session; a refusal names the original
todo to edit. Only the pack closes it, once every pull request it claimed has merged; one closed unmerged and never replaced fails the todo, and
you decide whether to redo or drop it. Read pull request and CI state with
neo.github.read; never ask the human to confirm it. Work in stages gets one todo
per stage, in order. Name pull requests as owner/repo#N, never a bare #N.
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
