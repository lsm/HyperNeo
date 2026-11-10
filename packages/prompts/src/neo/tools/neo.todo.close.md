---
id: neo.todo.close
---
Close a todo whose work is really done, with your reason; to cancel or replace it use neo.todo.remove. A todo that never started is refused, unchanged, unless its outcome check passes. A started todo is done only when its outcome check passes; otherwise it stays open, blocked by its check with the unmet reason, and finishes by itself once the check passes; if the check is wrong, fix it with neo.todo.edit check. Its session stops if it is running, unless the todo only follows a session the human tracked. A todo with an unanswered card is refused until the human answers it.
