---
id: work.rename
---
Rename existing work using a supported harness API. Workers are long-lived sessions. Name work for the matter it owns, never a task title. title is single-line plain text, trimmed, 1–200 characters. Codex uses thread/name/set so connected Desktop clients receive the name update without a restart; HyperNeo uses its session lifecycle API; Copilot uses session.name.set on HyperNeo-owned sessions (1–100 characters); Space uses task.update or agent.update. No other app private files or databases are written. Unsupported adapters return not_supported; API failures return not_delivered or unreachable with a reason. Only Neo or the user can rename work on another daemon.
