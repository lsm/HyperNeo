# Docked attachment previews and mobile bottom sheets

Build web (`cd packages/web && bun run build`). Use SKILL.md isolation: a fresh
synthetic run, empty HOME/data/DB, NODE_ENV=test, no keys or port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-attachment-preview-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/attachment-layout-seed.ts "$RUN"
```

The fixture captures Markdown and an immutable synthetic PR-file blob through the
real capture path with injected bytes. Run the CLI in a persistent terminal:

```bash
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" bun packages/cli/main.ts \
  --host 127.0.0.1 --port 9491 --db-path "$RUN/data/daemon.db"
```

Populate the card through RPC:

```bash
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/attachment-layout-seed.ts "$RUN" cards 9491
NODE_PATH=<playwright module directory> VERIFY_BROWSER=<headless Chromium executable> \
  node .claude/skills/verify/attachment-layout-web.mjs "$RUN" 9491
```

QA inventory: 1440/1120px wide layouts reserve a right column; chat and composer
stay inside the remaining space and accept typing; tapping the other attachment
replaces content in one panel; Escape from the composer and X close it. At
768/390/320px the sheet leaves an uncovered strip, opens from the bottom, and
closes from that strip, a vertical down swipe or X. Browser Back at every width
closes without leaving `/neo`. Horizontal swipes must not dismiss. Both complete
Markdown bodies and commit metadata must render, with no viewport overflow.
Retain `evidence/layout.json` and inspect the viewport screenshots for both files
at wide and narrow widths; numeric bounds alone are not a visual pass.

For human preview, visit `/neo`, then the **Synthetic** ask's question card. On
narrow screens open **Your work** at the top right first. Its attachments are
**Launch plan (Markdown)** and **proposal.md**. No model is configured. Keep this owned run for explicit human review; otherwise
stop it.

Repeat with `VERIFY_PLAIN_HTTP=1`: Chromium maps preview.invalid to localhost so
isSecureContext is false. Require the same behavior without crypto.randomUUID.
The wide composer must consume Escape to cancel a quote while retaining the
preview; a subsequent unconsumed Escape closes it. Retain each origin's layout.json.
