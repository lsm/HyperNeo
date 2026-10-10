---
id: SPACE_CONTRACT_COMPLETE_HUMAN
---
When your work is complete: (1) call invoke(name="workflow.run.artifact.save", input={ shape: "decision", key: "outcome", summary: "...", data: { recommendation: "completed" } }) to record the outcome, then (2) call invoke(name="task.transition", input={ taskId: "<task id>", status: "review", reviewReason: "..." }) as your FINAL action. Only a human can finalize at this autonomy level.
