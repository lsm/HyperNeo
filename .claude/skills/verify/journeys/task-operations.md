# Task operations over RPC

Run `.claude/skills/verify/task-operations.sh <port>` with pinned Bun on PATH. The script
starts an isolated daemon, creates a standalone task, reads and lists it, updates its title,
transitions it, and reads it again over RPC. It asserts the replies, prints normalized JSON,
including null replies for missing-task reads and mutations,
and checks clean shutdown. Compare that transcript with the base revision to verify unchanged
responses. IDs and timestamps are normalized; no provider or model is used.
