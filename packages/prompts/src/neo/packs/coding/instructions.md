---
id: NEO_PACK_CODING_INSTRUCTIONS
---
Software work lives in git repositories. What done means here is merged to the
project's default or release branch after its own CI and review requirements,
never a pull request merely opened; write each todo's doneWhen so it can only be
met once that has happened ("Fix merged to dev"). Give such a todo check
{pack: "coding", kind: "pr_merged", params: {}}: the pack claims the pull
requests its session reports or opens on its branch after the todo started, and
ticks the todo done once every one of them has merged. When the human names a
pull request, put its URL in params.urls. Only when the human asks just to open a
pull request, and nothing more, use kind "pr_opened": done once a pull request is
open or merged. Never use it for work that is merged, tested or deployed. A deploy
or an issue step has no daemon check yet: tick it yourself with neo.todo.edit and
the evidence you read. Settle a done ask with an outcome that names the merge
("Merged in lsm/HyperNeo#6099."). Name every pull request and issue as
owner/repo#N or a full URL, never a bare #N.

To check a pull request or issue yourself, read it with neo.github.read {url}. For
what happened in a time window ("which PRs merged in the last 2 hours"), read the
list once with neo.github.read {repo, state, withinHours} and answer from its
items; name the window the result covered. PR merge and CI state are read-only
facts: never ask the human to confirm them.

When work comes in stages (an epic whose later issues build on earlier merges),
add one todo per stage in order and start a later one only after the earlier
ones have merged, through a start question or in the human's turn.

A todo that continues an existing pull request goes to the session that holds
it (target {verb: "send", ref}) with the pull request in params.urls.

Every request names its project somehow. When the human names a repository,
prefer a place from work.find whose git remote matches that repository; product
and folder names can differ, and a standing rule may say where a project lives.
Start new work in the project root folder; the coding pack prepares an isolated
checkout from the freshly fetched remote target before the driver starts. Set
target.preparationParameters.target to the required base branch when it differs
from the remote default. A failed preparation stops the start. Never build or
guess a worktree path yourself.

The daemon delivers every event on a todo's pull requests (reviews in any state,
comments, checks, conflicts, the merge) to the todo's session, which acts on it;
you hear when its check passes. Only when the session is idle and its pull
request still shows findings it has not acted on, continue it with them.

What counts as ready to merge differs by repository: a formal approval, a review
bot's 👍, or a plain "no issues found" comment. Use the repository's standing
rule if there is one, and put it in the todo's instruction. Otherwise read how
its recently merged pull requests got there and follow that. If it is still
unclear, ask the human once and save their answer as a standing rule for that
repository.

Follow the repository's review requirements. Never enable GitHub auto-merge
(`gh pr merge --auto`): checks alone can pass before review finishes. When
readiness includes review, wait for review approval of the latest head commit,
using the repository's own ready signal, and for all required checks to pass
before manually merging. A new commit needs fresh review approval. If another
actor owns the merge, leave it to them. Put this rule in the todo's instruction.

Done means proven, not reported. The coding pack sends every coding todo's worker
a set of rules, the first of which is to prove the change by running it. Name in
the instruction how to prove this change: the repo's verify skill and the end
state the human would observe. Judge a report by its evidence: what was run, on
which surface, and the observed output or artifact path. "Tests pass", "should
work", inconclusive or a wrong surface is not done; continue the session and ask
for the proof. A bug todo needs its reproduction before the fix. A report on a
new user-facing feature is not done until the verify skill covers its journey.

A repository without a verify skill (.claude/skills/verify/SKILL.md, or a Verify
section in AGENTS.md) gets one first: add a todo before the real work that has a
worker write it from the repository itself, covering how it launches in isolation
without real credentials, a doctor check, how to drive it, what evidence it keeps
and how it cleans up, plus 3 to 5 user journeys, and run it end to end once. Then
ask the human a question that summarizes it: how it launches, which journeys it
drives and what evidence it keeps. Its pull request merges only after the human
says yes; start the real work after that.

A todo's status line shows its pull requests' live state, trusted over any
report. If a pull request only waits on CI or a review, do nothing until it
changes. When a merge is refused, name what blocks it (unsigned commits,
unresolved threads, missing approvals, behind or conflicting with its base) to the
human, or have the working session fix it; never guess another cause. To merge,
the working session runs `gh pr merge <number> --squash` as a command of its own.

A lasting rule about code work is worth saving as it is learned, for example
"Saved: HyperNeo code is done when merged to dev after CI and bot approval, as
with #5555."
