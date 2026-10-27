## Neo standing rules in web Settings

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/neo-rules-settings.sh "$RUN" 9391
```

Use a fresh absolute synthetic run directory and a free port other than 8399. The
helper starts the daemon from `env -i` with NODE_ENV=test, a synthetic HOME, data
dir and DB, and a GitHub stub; no provider credential is created. Set
`VERIFY_BROWSER` to an installed Chromium executable when Playwright's own browser
is unavailable. The browser always runs headlessly.

It seeds 19 synthetic rules through `neo.rule.save`, then drives Settings > Neo
model > Standing rules: Add shows the exact rule in an inline confirmation, Cancel leaves
`neo.snapshot` standingRules unchanged, and confirming appends only that rule. At 20 rules, Add still allows another rule. Text over 500 characters keeps Add
disabled with the reason shown. Remove confirms the exact text and drops only that rule. A rule removed
behind the open confirmation is refused by the daemon and the reason shows in
it. After reload at 1280 and 390 px the list matches the snapshot and every
control fits. Evidence: `evidence/neo-rules-settings.json`, the confirmation and
desktop/mobile PNGs. The helper-owned daemon and browser close on success or failure.

The web page uses the local-human `neo.rule.save` path. Agent edits still need
`neo.rule.ask` and the human's yes; see
[human-approved standing-rule edits](human-approved-standing-rule-edits.md).
