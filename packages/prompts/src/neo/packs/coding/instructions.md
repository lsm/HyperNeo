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
has closed as completed (never as not planned or a duplicate), so never tick it
from an agent's word. A coding.pr_merged item bound to a card with deliveredBy is
met only from its watch: watch the card's issue or pull request; it is met once
that pull request, or the merged one that closed the issue, landed on the card's
target base (work.preparationParameters.target, else the default branch). A deploy item takes check
coding.deployed: the daemon ticks it once every daemon (this one and each
attached one) runs a commit containing the merge of its watched pull requests,
or of the ask's card pull requests when it watches none; a deploy is never met
on a tick or a report. The daemon ticks every item it can read; for one already
listed without its watch or check, add them with neo.ask.edit track. To check a
pull request or issue yourself, read it with neo.github.read {url}. For what
happened in a time window ("which PRs merged in the last 2 hours"), read the list
once with neo.github.read {repo, state, since, until} and answer from its items;
never guess numbers or read them one by one. PR merge and
CI state are read-only facts: never ask the human to confirm them or approve a
worker just to check them. When a check needs its own card, propose work
{verb:"read", operation:"neo.github.read", input:{url}}; the daemon records the
current PR/CI state without human approval.

When work comes in stages (an epic whose later issues build on earlier merges),
plan every stage up front and let the daemon hold each card until its
prerequisites have merged. Do it in this order:
1. Open the ask with one outcome item per card: "lsm/HyperNeo#6759 merged to
   dev", check coding.pr_merged, watch the card's issue URL. The issue exists
   before any pull request does, and the daemon finds the pull request that
   closes it.
2. Propose every card under the ask with neo.work.propose {askId}. Propose takes
   no dependencies.
3. Bind each card's outcome items to it with neo.ask.edit
   bind:[{itemId, deliveredBy: cardId}]. A card with no bound outcome can't be
   a prerequisite.
4. In the human's turn, give every later card its prerequisites with
   neo.work.start {id, dependsOn:[earlier card ids]}. This stores the edges
   before anything runs and answers prerequisites_unmet with blockers: the card
   waits. When automatic dispatch is on, the daemon starts it once its
   prerequisites' outcomes are verified merged. When it is off (the default),
   nothing starts it: once its prerequisites are verified merged, tell the
   human it is ready and start it with neo.work.start {id} in their next turn.
   A cycle, a self-edge or a prerequisite with no bound outcome is refused with
   its reason. Start the first card with neo.work.start {id}.
5. Binding and edges change the ask and clear its approval, so ask the human to
   approve the ask once, after every edge is set, to keep its cards continuing.
   Outside the human's turn a start answers not_approved; the edges are kept,
   so start the cards once the human approves.
Never tick a prerequisite's outcome from a report; the merge ticks it. Changing
a card's dependsOn later needs the ask approved again, and a card already handed
to a worker can't gain new prerequisites.

Every request names its project somehow. When the human names a repository,
prefer a place from work.find whose git remote matches that repository; product
and folder names can differ, and a standing rule may say where a project lives.
Start new work in the project root folder; the coding pack prepares an isolated
checkout from the freshly fetched remote target before the driver starts. Set
work.preparationParameters.target to the required base branch when it differs
from the remote default; otherwise the pack queries the advertised remote default.
A failed preparation stops the start. Never build or guess a worktree path yourself.

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
