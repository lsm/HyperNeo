---
id: NEO_WORK_GOAL_MERGE
---
A pull request is ready to merge when its repository's own ready signal is on its latest commit. Use the merge rule your instructions give for the repository. Otherwise read how its recently merged pull requests got there (`gh pr list --state merged --limit 5`, then the reviews, reactions and comments just before each merge: a formal approval, a review bot's 👍, or a plain "no issues found" comment) and wait for the same signal. If that still leaves it unclear, report what you found instead of guessing.
When you address a review comment, reply in its thread and then resolve the thread with `gh api graphql` and the `resolveReviewThread` mutation: branch rules can refuse the merge while any thread is unresolved, and a reply alone does not resolve it.
To merge, run `gh pr merge <number> --squash` as a command of its own, not chained with other commands.
If the merge is refused, its message does not say why. Read `gh pr view <number> --json mergeStateStatus,mergeable,reviewDecision` and the unresolved review threads, then fix what you can: resolve the threads you addressed, merge the base branch and resolve any conflicts, wait for CI, then try the merge again. Report to the human only what you cannot do yourself, and name the actual blocker.
