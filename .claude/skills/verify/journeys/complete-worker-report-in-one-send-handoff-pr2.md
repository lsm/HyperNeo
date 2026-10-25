## Complete worker report in one send (handoff PR2)

Run the real SDK MCP send and Neo read against a loopback scripted model, then
run the actual `hyperneo send` CLI through an isolated owner-only Unix socket:

```bash
RUN=$(mktemp -d "$PWD/.verify-message-send.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-message-send.ts "$RUN" 9362
```

Choose a free non-8399 port and a fresh directory. Only synthetic SDK children
receive a dev-proxy credential pointing at the loopback mock. End state:
`evidence.json` records one worker MCP `message.send {to,text}` containing all
8,192 bytes, an accepted receipt with SHA-256, the same reference in the durable
mailbox, and identical complete bytes read through Neo's real MCP and native Read
interfaces. The helper reopens its own SQLite DB after removing the completed
synthetic mailbox row; retrying with the same `idempotencyKey` must return the
same receipt without another job. The actual CLI must also deliver all 8,192
bytes through its Unix HTTP door using the simple shape.

The Neo SDK system prompt uses an explicit empty pack list with the current
neoPrompt API. The Neo SDK prompt is taken from the durable mailbox payload. This checks the
send/receipt/read interfaces; it does not run the daemon's automatic mailbox
consumer or a GUI. It closes SDK streams, the socket and mock server in `finally`.
Preserve evidence outside the worktree, then remove only the synthetic run before
repository checks. Keep the same-user trust boundary from PR1: no OS isolation is
claimed, and reads detect changed published bytes instead of returning them.
The contract suite also seeds an interrupted partial draft and sends the same
report concurrently to different recipients; every accepted report must retain
all bytes. Explicit file arrays accept 20 references; 21 must return a schema error
that names the limit and the option of sending additional references separately.
