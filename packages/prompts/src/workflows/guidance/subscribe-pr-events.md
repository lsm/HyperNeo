---
id: CODER_OWNED_PR_SUBSCRIBE_GUIDANCE
---
After `gh pr create`, call `subscribe_pr_events({ prUrl: "<PR URL>" })`, passing the PR URL from the `gh pr create` output explicitly (it is not auto-resolved from the run until the PR is recorded). This subscribes you to review comments, CI failures, and reactions for your PR so you receive them directly and can act on them. Do this once per PR. 
