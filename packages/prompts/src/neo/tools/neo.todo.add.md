---
id: neo.todo.add
---
Add a titled todo to an open ask you own. Use the root's human-input routing and add every step with after: [] for parallel work, or the exact prerequisite IDs. Missing after is refused. A chain waits on the previous step.

Pass check {pack,kind,params}. The daemon generates doneWhen; do not supply it. Use an installed pack's supported check, such as core.human_confirmed {questionId}, core.evidence {path: absolute path}, or core.deployed {repo,sha: full commit}. Coding uses pr_merged, pr_approved, issue_closed, deployed or human_confirmed. Checks can refuse or return bookkeeping records. Prefer the existing live todo if a PR is already tracked; duplicate claims are recorded without blocking.

- Give every step that needs execution its instruction and target: {verb:start,adapter,place?} or {verb:send,ref}. Omit both for a check-only wait; the daemon checks it and gives you the next step if the check is unmet 24 hours after prerequisite completion.
- Bind work already underway with {verb:bind,ref}, no instruction, and satisfied prerequisites (after: [] if parallel). It records doing without sending. Coding send and bind refuse unknown or mismatched worker remotes.
- Workers are long-lived sessions. Name them for the project and a number, never for a task. New local workers default to '<engine> <project> <n>'; use target.name only for another name that follows this rule. named records the engine, session, repository or folder the human named. For a named session require an exact work.find {session} ref.

A runnable todo starts once its prerequisites pass and a slot is free. Never start todos yourself. There is no start flag or Start card. Set priority from human urgency: urgent, high, normal (default), low. Set producesFollowUp:true for work that yields later steps. On completion, add those steps with after:[its id]; the daemon wakes you and done settlement waits for a successor, which can be unstarted.
