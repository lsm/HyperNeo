# Curated home reads without holder state

Run `bash .claude/skills/verify/neo-home-read-sync.sh "$RUN"` from the worktree
root with a fresh absolute synthetic directory. Follow SKILL.md isolation. The
helper owns a test HOME, data dir, database and daemon on an ephemeral loopback
port, a local Git peer/bare remote and an in-memory protocol MCP client. No model,
real provider, credentials, GUI or port 8399 is used. GitHub is stubbed.

Neo MCP and human RPC reads both independently synchronize. Peer updates must
appear on the next read without a new turn. A failed fetch must retry on the
next read; no holder lifetime or wake cache may gate it. Dirty human edits are no longer a refusal: the read synchronizes (one more
fetch), returns the uncommitted bytes and leaves the edit and HEAD unchanged. The
fixture Git wrapper counts ten fetches across those reads and retains RPC/MCP
replies in
`evidence/neo-home-read-sync.json`; its resources close in finally.

The prior once-per-holder-wake cache was deleted in #8114. The focused home
contracts retain conflict, symlink, ignored-file, exact consent and revision
checks. Real network authentication and killed-process Git recovery are not
verified by this local journey.
