16. **Neo's messages to its workers show in Neo's conversation; theirs to Neo do not.** Run
    `.claude/skills/verify/neo-session-rows.sh <port> "$RUN"`. It opens root, creates
    a worker session "Fix the loader", and sends one message each way. End state: it
    prints only `Neo -> Fix the loader: Rebase on dev, then tell me.` for both
    `neo.conversation.read` and the snapshot's `sessionMessages`; the worker's
    `Rebased.` is still delivered to root but is not a row. On `/neo` Neo's message
    shows as one collapsed row "Neo → Fix the loader" with its first line.
