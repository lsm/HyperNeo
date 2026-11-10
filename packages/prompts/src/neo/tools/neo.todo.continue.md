---
id: neo.todo.continue
---
Send a started todo's session its next step. Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. The todo goes back to doing until the session reports again, and a card it was waiting on closes with it. An unstarted todo or settled ask returns a record without dispatching or approving a start.
