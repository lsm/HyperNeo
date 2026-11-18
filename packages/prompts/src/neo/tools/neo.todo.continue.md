---
id: neo.todo.continue
---
Send a started todo's session its next step. Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. The todo goes back to doing until the session reports again, and a card it was waiting on closes with it. A pending relayed-session decision must be answered by the human before this todo can continue. An unstarted todo or settled ask returns a record without dispatching or approving a start. A failed todo gets a new attempt in place, keeping its todoId: its worker gets message, or its original instruction without one; with no worker its recorded target starts again. Do not remove and replace it. Only a failed todo may omit message.
