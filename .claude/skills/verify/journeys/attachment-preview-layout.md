# Docked attachment previews and mobile bottom sheets

Build web (`cd packages/web && bun run build`). Use SKILL.md isolation: a fresh
synthetic run outside configuration folders, empty HOME/data/DB, NODE_ENV=test,
no keys or port 8399. No GUI takeover or model turn is needed.

```bash
RUN=$(mktemp -d /private/tmp/hn-attachment-preview-XXXXXX); mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/attachment-layout-seed.ts "$RUN"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" bun packages/cli/main.ts --host 127.0.0.1 --port 9491 --db-path "$RUN/data/daemon.db"
```

Keep the CLI in its persistent terminal. In another terminal, populate the card:
`env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/attachment-layout-seed.ts "$RUN" cards 9491`.
Run `node .claude/skills/verify/attachment-layout-web.mjs "$RUN" 9491` with NODE_PATH
pointing to Playwright and VERIFY_BROWSER to headless Chromium. Repeat with
VERIFY_PLAIN_HTTP=1: preview.invalid maps to localhost; isSecureContext must be
false and crypto.randomUUID undefined. Only injected synthetic Git bytes are used.

QA: 1440/1120px reserve a right column with editable chat and replacement content.
768/390/320px show an upward entrance, uncovered strip and downward dismissal.
X, unconsumed Escape and browser Back close without leaving Neo; horizontal swipes
do not. A quote, preferences popover or image lightbox consumes its own Escape
without losing the preview, including when focus leaves the overlay. Component
coverage uses the real Markdown renderer; browser coverage uses real preferences.
Inspect both files' screenshots and bounds; retain each origin's layout.json.

For human review, visit `/neo`, then **Synthetic** (on narrow screens, first tap
**Your work**). Open **Launch plan (Markdown)** or **proposal.md**. No model is
configured. Keep this owned run for explicit human review; otherwise stop it.
