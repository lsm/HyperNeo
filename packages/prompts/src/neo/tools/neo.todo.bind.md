---
id: neo.todo.bind
---
Coding work requires worker remotes matching the todo repository; mismatched or unknown remotes are refused. Bind an unfinished todo on an open ask to an existing running worker, without sending or starting anything. Use this to repair a failed backfill instead of retrying its instruction. Records worker and doing, clears failure and old delivery evidence; does not stop the existing worker. A step with unfinished prerequisites is refused, so add independent running work with after: [].
