---
id: neo.todo.retarget
---
Move a todo off the worker named by fromRef, after confirming it has stopped. Only work started for this todo can move; sent, adopted or shared workers are refused. A repeated old fromRef changes nothing. The move survives restart, clears the old worker's held prompt, and retains the stored target for the normal start path.
