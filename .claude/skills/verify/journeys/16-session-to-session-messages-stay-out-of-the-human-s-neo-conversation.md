16. **Session-to-session messages stay out of the human's Neo conversation.** Run
    `.claude/skills/verify/neo-session-rows.sh <port> "$RUN"`. It opens root, creates
    a worker session "Fix the loader", and sends one message each way. End state:
    both sends succeed, but the human's `neo.conversation.read` and
    `neo.snapshot` print no session row (`human session rows: 0`, `snapshot
    sessionMessages: absent`). On `/neo` neither message shows; the page carries only
    the human's messages, Neo's publications and cards, and needs-you notices.
