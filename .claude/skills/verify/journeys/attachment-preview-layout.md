# Docked attachment previews and mobile bottom sheets

Build this worktree's web bundle with `cd packages/web && bun run build`. Follow
SKILL.md's isolated setup: a fresh synthetic run outside configuration folders,
empty HOME, own data/DB, NODE_ENV=test, no keys and a free port other than 8399.
No GUI takeover or model turn is needed.

```bash
RUN=$(mktemp -d /private/tmp/hn-attachment-preview-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/attachment-layout-seed.ts "$RUN"
```

The seed reuses the registration fixture and captures a small Markdown file plus
an immutable synthetic PR-file blob through the real capture path. Its Git reader
is injected synthetic bytes; no GitHub or credential access occurs. Run the source
CLI in a persistent terminal, with the refusing stub from the ordinary launch
setup at the front of PATH. Use this branch's built web assets:

```bash
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" bun packages/cli/main.ts \
  --host 127.0.0.1 --port 9491 --db-path "$RUN/data/daemon.db"
```

In another terminal, populate the question card through public RPC:

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
**Launch plan (Markdown)** and **proposal.md**. No model is configured. The
preview-only run may stay active for explicit human review; otherwise stop only
its owned process. Do not copy a live DB or stop another daemon.
