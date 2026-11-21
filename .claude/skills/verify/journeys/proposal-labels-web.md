## Proposal cards show Neo's button labels, or Confirm / Cancel

Build the web bundle (`cd packages/web && bun run build`). Seed a fresh synthetic run,
launch per SKILL.md on a free port (never 8399), then drive headless Chromium:

```bash
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/proposal-labels-seed.ts "$RUN" zh-Hans
.claude/skills/verify/launch.sh <port> "$RUN"
HYPERNEO_DATA_DIR="$RUN/data" NODE_PATH=<playwright> node .claude/skills/verify/proposal-labels-web.mjs <port> "$RUN" zh-Hans
```

Pass `en` to both for English. The seed opens two synthetic proposals: one without labels
and one with labels Neo wrote (发出去 / 先不做). No key or model is used.

- `proposal-labels-<language>.json` has `passed: true` and four views (desktop and phone,
  light and dark).
- The unlabeled card shows 确定 / 取消 in Chinese and Confirm / Cancel in English; the
  labeled card shows 发出去 / 先不做 in both.
