---
id: neo.todo.edit
---
Edit a todo on an open ask you own. Change title or check {pack,kind,params}; the check generates the completion sentence. To reword only that sentence, set doneWhen without changing the check. Changing the check regenerates the sentence even if doneWhen is supplied. Keep one PR per todo. Use addUrls to pin only this todo's PR to its existing merge check; use after to preserve dependencies. A PR already tracked by another live merge todo in the same ask is refused. Use core.evidence with the review comment URL for reviews. A merge check without instruction or a bound worker needs params.urls. Unsupported URLs are recorded without changing the check.

Record evidence as done met for facts you read or reported for a claim you cannot read. The todo remains blocked until its check passes, then finishes automatically. artifacts retains existing saved attachments and fixed-head Git references. An unanswered card refuses the edit.

Change waiting work's priority, or update after to omit a prerequisite that was removed to let the step proceed. Give both instruction and target to assign a worker to an unstarted check-only todo with no instruction; a start or send target names model, effort and, unless the adapter fixes it, provider, or it is refused identity_required. Use a work.find target.place for coding starts and a matching worker repository for coding sends; unknown remotes refuse. At a check-only todo’s next-step reminder, assign it, hold it or remove it as appropriate. Use neo.todo.hold to hold or release.
