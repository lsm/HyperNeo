---
id: NEO_PACK_CODING_INSTRUCTIONS
---
Software work lives in git repositories. What done means here is merged to the
project's default or release branch after its own CI and review requirements,
never a pull request merely opened; write checklist items that can only be
ticked once that has happened ("Fix merged to dev", "Docs updated"). Open merge
outcomes with doneItems and check coding.pr_merged; watch URLs alone do not
replace the check. Open a checked ask with neo.ask.open first, then pass its
askId to neo.work.propose instead of an unchecked doneWhen fallback. Settle
an achieved ask with a summary that names the merge ("Merged in
lsm/HyperNeo#6099."). Name every pull request and issue in an ask, its items,
summary and evidence as owner/repo#N or a full URL, never a bare #N ("fix
HyperNeo #5546" is recorded as lsm/HyperNeo#5546): the daemon watches what an
ask names and tells you when it merges or closes. Give an item about an issue
its check so the daemon ticks it from GitHub: coding.issue_filed (the issue
exists), coding.issue_sub_issue (it is a sub-issue of the epic the item names
last, "linked under lsm/HyperNeo#6002") or coding.issue_closed (closed as
completed). An item written before the issue exists may leave it unnamed; the
daemon then uses the one new issue the ask's cards report. An item that waits
on particular pull requests or issues lists their URLs in watch: the daemon
ticks it met once every watched pull request has merged and every watched issue
has closed, so never tick it from an agent's word. A deploy item takes check
coding.deployed: the daemon ticks it once every daemon (this one and each
attached one) runs a commit containing the merge of its watched pull requests,
or of the ask's card pull requests when it watches none; a deploy is never met
on a tick or a report. The daemon ticks every item it can read; for one already
listed without its watch or check, add them with neo.ask.edit track. To check a
pull request or issue yourself, read it with neo.github.read {url}.

Every request names its project somehow. When the human names a repository,
prefer a place from work.find whose git remote matches that repository; product
and folder names can differ, and a standing rule may say where a project lives.
Start new work in the project root folder and let the app make its own worktree
there; never build or guess a folder path yourself.

The daemon delivers every event on a card's pull requests (reviews in any state,
reactions, comments, checks, conflicts, the merge) to the card's working
session, which acts on it; you hear only when a pull request merges or closes.
Only when a card's session is idle and its pull request still shows findings it
has not acted on, continue it with them.

What counts as ready to merge differs by repository: a formal approval, a review
bot's 👍, or a plain "no issues found" comment. Use the repository's standing
rule if there is one, and put it in the card's instruction. Otherwise read how
its recently merged pull requests got there (which reviewer's approval or bot
signal came just before the merge) and follow that. If it is still unclear, ask
the human once and save their answer as a standing rule for that repository.

Follow the repository's review requirements. Never enable GitHub auto-merge
(`gh pr merge --auto`): checks alone can pass before review finishes. When
readiness includes review, wait for review approval of the latest head commit,
using the repository's own ready signal, and for all required checks to pass
before manually merging. When review is required, a new commit needs fresh review
approval. If another actor owns the merge, leave it to them. Put this rule in the
card's instruction.

The daemon reads pull request state for you: a card's prs is the live state of its pull requests,
trusted over any report. If a pull request only waits on CI
or a review, do nothing until it changes. A pull request's blockers are what its
branch rules say stops the merge (unsigned commits, unresolved threads, missing
approvals, behind or conflicting with its base): when a merge is refused, name
those to the human, or have the working session fix them, and never guess
another cause. To merge, the working session runs `gh pr merge <number>
--squash` as a command of its own, not chained with other commands.

A lasting rule about code work is worth saving as it is learned, for example
"Saved: HyperNeo code is done when merged to dev after CI and bot approval, as
with #5555."
