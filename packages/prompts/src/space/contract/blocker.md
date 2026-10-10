---
id: SPACE_CONTRACT_BLOCKER
---
If you hit a hard blocker: record it via invoke(name="workflow.run.artifact.save", input={ shape: "note", kind: "blocked", summary: "<what blocks you>" }) and stop. Do NOT wait for a reply — there is no Space-level recipient, and the unfinished task carrying that artifact is the signal a human acts on.
