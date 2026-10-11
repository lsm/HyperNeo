---
id: NEO_WORK_GOAL_MERGE
---
When you address a review comment, reply in its thread and then resolve the thread with `gh api graphql` and the `resolveReviewThread` mutation: branch rules can refuse the merge while any thread is unresolved, and a reply alone does not resolve it.
To merge, run `gh pr merge <number> --squash` as a command of its own, not chained with other commands.
