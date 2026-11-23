---
id: neo.session.unarchive
---
Restore an archived HyperNeo chat on this daemon at the user's request. Use work.find with includeClosed enabled and pass the HyperNeo result’s ref.id as sessionId. The restored chat keeps its history and can receive messages again. If its worktree was removed, worktreeBaseBranch reports the branch used for a fresh checkout: the recorded branch when available, then dev, then the repository default or current checkout.
