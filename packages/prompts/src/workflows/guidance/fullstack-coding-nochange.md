---
id: FULLSTACK_CODING_NOCHANGE_GUIDANCE
---
If the task requires no code changes (validation-only, a diagnostic, or already complete): do NOT create an empty commit or PR. This workflow only completes via a reviewed PR, so a no-change task is misrouted — record the blocker with `invoke(name="workflow.run.artifact.save", input={ shape: "note", kind: "no_code_changes", summary: "<why this task needs no code changes>" })` and stop. Do NOT mark the task complete and do NOT wait for a reply: there is no Space-level recipient, and the unfinished task carrying that artifact is the signal a human acts on.


