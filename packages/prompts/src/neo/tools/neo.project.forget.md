---
id: neo.project.forget
---
Delete a project at the human’s request: its workspace aliases and row go, so its repositories leave the PR ledger. The repository and local folders are untouched; new work in one of its folders creates a project again. Root Neo or the local human only (root_or_human_only). Settled asks move to the root. Refuses the Inbox (project_protected) and a project that still has child sections, cards, open asks, merges or worker bindings (project_in_use); an unknown id is project_missing.
