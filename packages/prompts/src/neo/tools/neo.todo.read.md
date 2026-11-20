---
id: neo.todo.read
---
Read one todo in full by todoId: its instruction, report, evidence, check and state. neo.ask.read and the todo change tools list only each todo's id, title and state; read a todo here when you need its details.

For a start target, startConfiguration shows requestedModel and requestedEffort from the target and actualModel and actualEffort recorded for the worker. Null actual values are unconfirmed. Compare the resolved model ID and effort, accounting for display names and aliases. If the worker started with different settings, stop that todo's worker and confirm it stopped. Use neo.todo.retarget if the stored target has the right settings, or replace the todo with the correct target.model and target.effort. Verify the replacement before reporting success.
