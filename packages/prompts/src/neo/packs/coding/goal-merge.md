---
id: NEO_WORK_GOAL_MERGE
---
When you address a review comment, reply in its thread and then resolve the thread with `gh api graphql` and the `resolveReviewThread` mutation: branch rules can refuse the merge while any thread is unresolved, and a reply alone does not resolve it.
To merge, run `gh pr merge <number> --squash` as a command of its own, not chained with other commands.
If the merge is refused, its message does not say why. Read `gh pr view <number> --json mergeStateStatus,mergeable,reviewDecision` and the unresolved review threads, then fix what you can: resolve the threads you addressed, merge the base branch and resolve any conflicts, wait for CI, then try the merge again. Report to the human only what you cannot do yourself, and name the actual blocker.
