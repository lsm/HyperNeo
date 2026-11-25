## Settings > About links to the HyperNeo repo and labels the docs as upstream (Settings P17)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 VERIFY_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  .claude/skills/verify/about-links.sh 9321
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key) and drives
paired headless Chromium with `about-links-view.mjs` to `/settings?tab=about`.
The Web click opens a synthetic popup served by Playwright. Desktop-mode clicks
are observed through a fixture for the native bridge. Confirm both destinations
are handed to the system opener and the desktop page stays on Settings. No
external site is contacted.

End state, in `$RUN/evidence/`:
- `about-links.json`: the page stays at `/settings?tab=about`; `GitHub` points at
  `https://github.com/lsm/HyperNeo`; the docs link reads
  `Anthropic / Claude Agent SDK docs (upstream)` and still points at
  `https://docs.anthropic.com`. The script fails on any other value.
- `about-1280.png`: the About section with both links.
