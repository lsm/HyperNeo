# OAP streamed messages persist once

Build the web bundle and use `proof-run.sh` with pinned Bun, the pinned OXAP binary,
Playwright and an installed Chromium, following `../SKILL.md`. Supply the absolute
binary path, its release name (what `--version` prints) and SHA-256 as arguments;
the helper installs it through `oxap.settings.save` as in `oxap-hub-settings.md`:

```bash
TMPDIR=/private/tmp NODE_PATH=/absolute/playwright/node_modules VERIFY_BROWSER=/absolute/chromium \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 delta-coalesce
```

The helper uses an isolated daemon and a synthetic Codex app-server peer. It
sends 96 native text deltas through the real OAP binary and the public session
RPC, checks one stored assistant message contains their joined text, and checks
one matching bubble in the served session UI. It saves session and Neo
screenshots, then stops its daemon and synthetic peer. Separately run
`oap-workspace-refusal.ts` through `proof-run.sh` to verify that interleaved
reasoning and text deltas also produce one stored assistant per synthetic turn.
No real Codex account, provider response or network connection is exercised.
