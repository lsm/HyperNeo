# Unsupported controls in an OXAP Codex chat

Use the shared isolation and pinned Bun in [Verify](../SKILL.md). Build the web
bundle, verify the OXAP archive as in [OXAP settings](oxap-hub-settings.md), and
set `NODE_PATH` and `VERIFY_BROWSER` for Playwright.

```sh
HYPERNEO_SPACE=off TMPDIR=/private/tmp VERIFY_PROOF_PREFIX=ct- \
  bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/oap-workspace-wire.ts "$OXAP" "$RELEASE" "$SHA256" \
  codex-turn-controls "$CODEX" "$CODEX_HOME_OWNER"
```

Pass the absolute Codex executable and the signed-in user's home directory.
Only the Codex child uses that home. The daemon keeps its disposable HOME,
database and loopback listener. The relay records method names only.

Send a prompt in the browser. While Codex is running, the composer offers
Queue for next turn, and the queued row can be removed. Neither surface offers
Steer. Wait for both answers. Submit `/compact` and check that the composer
reports it unavailable and retains the draft. The native relay records two
`turn/start` calls and no `turn/steer` or `thread/compact/start` requests.
Inspect the composer, queued row and manual compaction screenshots.
