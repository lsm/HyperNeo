---
id: neo.session.unarchive
---
Restore an archived HyperNeo chat on this daemon at the user's request. Use work.find with includeClosed enabled. Pass ref.id as sessionId only for a HyperNeo result whose ref has no daemon field. For a paired daemon result, direct the user to Chats on the owning daemon. The restored chat keeps its history and can receive messages again. If its worktree was removed, worktreeBaseBranch reports the branch used for a fresh checkout: the recorded branch when available, then dev, then the repository default or current checkout.
