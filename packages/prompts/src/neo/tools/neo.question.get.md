---
id: neo.question.get
---
Read one of Neo's questions to the human by id: its text, state, answer and optional home path/hash binding. Its document field, when present, returns the full text separately from the short card text. answeredByHuman is true only when the human answered it, by button or in their own chat; use it to check a decision another session reports. resolvedByAgent marks a cited Neo resolution, whose durable citation is in retiredReason; it is never human approval.
