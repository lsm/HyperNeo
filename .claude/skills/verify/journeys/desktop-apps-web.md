## Desktop control follows the ask's approved apps

Build the web bundle (`cd packages/web && bun run build`). Seed a fresh synthetic run,
launch per SKILL.md on a free port (never 8399), then drive headless Chromium:

```bash
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/desktop-apps-seed.ts "$RUN" zh-Hans
.claude/skills/verify/launch.sh <port> "$RUN"
HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH=<playwright> node .claude/skills/verify/desktop-apps-web.mjs <port> "$RUN" zh-Hans
.claude/skills/verify/stop.sh "$RUN"
```

Pass `en` to both for English. The seed opens three synthetic asks: a proposal whose card
lists Chrome, a running todo on an ask approved for Chrome, and a running todo on an ask
with no approved app. No key or model is used.

- `desktop-apps-<language>.json` has `passed: true` and four views (desktop and phone,
  light and dark), two shots each.
- The proposal card ends with the line `🖥 Chrome`.
- The Chrome todo shows the computer icon, titled "Can use Chrome on this computer. Click to
  stop." (可以用这台电脑上的 Chrome，点一下可以关掉).
- The todo whose ask has no approved app shows no computer icon.
