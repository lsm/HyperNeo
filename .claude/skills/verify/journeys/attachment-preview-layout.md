# Docked attachment previews and mobile bottom sheets

Build web (`cd packages/web && bun run build`). Follow SKILL.md isolation: fresh synthetic HOME/data/DB, NODE_ENV=test, no keys, GUI takeover, model turn or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-attachment-preview-XXXXXX); mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/attachment-layout-seed.ts "$RUN"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" bun packages/cli/main.ts --host 127.0.0.1 --port 9491 --db-path "$RUN/data/daemon.db"
```

Keep the CLI in its persistent terminal. In another terminal, populate the card: `env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/attachment-layout-seed.ts "$RUN" cards 9491`.
Run `node .claude/skills/verify/attachment-layout-web.mjs "$RUN" 9491` with NODE_PATH
pointing to Playwright and VERIFY_BROWSER to headless Chromium. VERIFY_PLAIN_HTTP=1
uses preview.invalid: require isSecureContext=false and crypto.randomUUID undefined.

QA: 1440/1120px reserve a right column with editable chat and replacement content.
768/390/320px show an upward entrance, uncovered strip and downward dismissal.
IME Escape keeps the preview open (including key code 229); unconsumed Escape, X and browser Back close without leaving Neo. Horizontal swipes
do not. A quote, preferences popover or image lightbox consumes its own Escape
without losing the preview, even after focus leaves. Use the real Markdown renderer and preferences. Inspect both files' screenshots/bounds; retain each layout.json.

Visit `/neo` → **Synthetic** (narrow: **Your work**) → **Launch plan (Markdown)** or **proposal.md**. Keep the owned run for human review; otherwise stop it.
