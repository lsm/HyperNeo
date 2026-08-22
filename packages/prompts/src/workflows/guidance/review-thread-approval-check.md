---
id: REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE
---
Verify the PR is still open, mergeable, and has no unresolved GitHub review conversations. Use `gh api graphql` to inspect `reviewThreads` and confirm every thread has `isResolved: true`; if unresolved conversations remain, request the author to resolve them instead of approving. Never set a PR to auto-merge — auto-merge is not allowed.
