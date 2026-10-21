## A browser pairs at /pair#<code> and keeps an HttpOnly device cookie (S4 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/web-pairing.sh 9319
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key), makes codes with
`hyperneo pair`, and drives headless Chromium with `web-pairing-view.mjs`
(Playwright from `PLAYWRIGHT_NODE_PATH`, default the Homebrew `@playwright/cli`
install). Codes and credentials stay in shell variables; the screenshot of a live
code masks the code field.

End state, in `$RUN/evidence/`:
- At 1280 and 390 wide, a made-up code shows `That code is wrong or expired. Make a
  new one with hyperneo pair.`
- At 1280, the first code pairs: `This browser is paired.`, the URL is `/pair` with
  no `#code`, and the only cookie is `hyperneo_device` (43 characters, `httpOnly`,
  `sameSite: Strict`, `path: /`, not `secure` on plain http; `document.cookie` cannot
  see it). Opening HyperNeo then marks `Browser 1280` as seen at the daemon's host,
  so the app's WebSocket sent the cookie.
- At 390, a second code made after a device is paired answers `This code needs Allow
  first. Tap Allow on your paired phone, then pair again.`
- Neither code appears in the daemon log.
- Screenshots: `form`, `wrong-code` (both widths), `paired-1280`, `awaiting-390`.
