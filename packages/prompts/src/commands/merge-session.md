---
id: MERGE_SESSION_COMMAND_PROMPT
---
Complete the current worktree session workflow:

1. Create logical commits for all changes in this worktree
2. Detect the current branch in the root repository (could be main, dev, feature branch, etc.)
3. Pull rebase on that target branch in the root repository
4. Fast-forward merge this session branch to the target branch in the root repository
5. Push to remote

Follow git best practices:
- Create atomic, logical commits with clear messages
- Verify no conflicts during rebase
- Ensure the merge is fast-forward only
- Detect and use whatever branch is currently checked out in the root repo
