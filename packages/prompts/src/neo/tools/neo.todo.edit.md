---
id: neo.todo.edit
---
Edit a todo on an open ask you own. Change title or check {pack,kind,params}; the check generates the completion sentence. To reword only that sentence, set doneWhen without changing the check. Changing the check regenerates the sentence even if doneWhen is supplied. addUrls pins only this todo's PR to its existing PR-merge check. Duplicate claims and unsupported URLs are recorded without blocking; edit the existing PR todo instead of adding a duplicate.

Record evidence as done met for facts you read or reported for a claim you cannot read. The todo remains blocked until its check passes, then finishes automatically. artifacts retains existing saved attachments and fixed-head Git references. An unanswered card refuses the edit.

Change waiting work's priority, or update after to omit a prerequisite that was removed to let the step proceed. Give both instruction and target to assign a worker to an unstarted check-only todo with no instruction. Use a work.find target.place for coding starts and a matching worker repository for coding sends; unknown remotes refuse. At a check-only todo’s next-step reminder, assign it, hold it or remove it as appropriate. Use neo.todo.hold to hold or release.
