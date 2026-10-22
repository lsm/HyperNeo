## Worker handoff outbox (PR1)

Run the real SDK tools against a loopback-only scripted model. No GUI, daemon
restart, live DB, real keys or real transcripts are involved. Pick a free port
other than 8399. The parent environment is empty; only each synthetic SDK child
receives the dev-proxy credential and loopback base URL.

```bash
RUN=$(mktemp -d "$PWD/.verify-handoff.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-handoff.ts "$RUN" 9361
```

`worker-handoff.ts` resolves the repository's installed SDK executable through
its production resolver (new SDK versions ship a native executable, not cli.js).
It drives worker native Write → real MCP `handoff.publish`, then a separate Neo
SDK session through real MCP `handoff.read` and native Read. The report must retain
all 12,000 UTF-8 bytes and SHA-256. A sibling private file, a published symlink and
a changed snapshot must return denial through handoff.read without their contents; the changed file
must report `tampered`. `evidence.json` records receipts and actual tool results.
The script closes both SDK streams and its mock server. Before repository checks,
preserve evidence outside the worktree, then remove only this synthetic run
(the SDK writes unformatted configuration into its temporary HOME). Native Read of the published report remains available, but the removed Neo hook
no longer performs native Read hash/path checks; the verified operation owns them.
This verifies tool behavior,
not GUI rendering or protection against a malicious same-user OS process.
