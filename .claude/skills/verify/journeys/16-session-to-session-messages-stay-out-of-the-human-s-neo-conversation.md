16. **Session-to-session messages stay out of the human's Neo conversation.** Run
    `HYPERNEO_DATA_DIR="$RUN/data" .claude/skills/verify/neo-session-rows.sh <port> "$RUN"`.
    It opens root, creates a worker session "Fix the loader", and sends one message
    each way. It exits non-zero unless both sends are accepted, the run-local database
    records exactly those two rows (Neo to worker, worker to Neo), the human's
    `neo.conversation.read` holds no session row, and `neo.snapshot` carries no
    `sessionMessages` field. On `/neo` neither message shows; the page carries only
    the human's messages, Neo's publications and cards, and needs-you notices.
