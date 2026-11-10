---
id: neo.todo.retry
---
Retry a failed todo in place with a new attempt, keeping its todoId. A nonretryable todo or settled ask returns a record without dispatching. If it has a worker, send the original instruction to that worker; otherwise start its recorded target again. Do not remove and replace it. Choose the delivery channel or adapter for reaching the same worker session yourself; never ask the human to choose it. Ask the human before changing which worker or target does the work.
