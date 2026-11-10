---
id: neo.coding.pr.file
---
Attach a complete PR file as an immutable document, never a diff. Owner Neo only. Pass an ask/todo context, GitHub owner/repo#N or PR URL, listed path, current 40-hex headSha and a stable requestId. Reuse the UUID only for identical inputs; a changed head/path/PR needs a fresh UUID. Returns an ArtifactRef usable in neo.question.ask artifacts. Explain changes in card text.
