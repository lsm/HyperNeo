# Anthropic 1M context reaches the SDK and Settings

Use shared isolated setup in SKILL.md. No live daemon, real DB or real credentials.
The provider currently discovers models with the Agent SDK, not the Models API;
the static capability table is sourced from https://platform.claude.com/docs/en/models/overview
(read 2026-10-24). Unknown and legacy models keep their existing windows.

Run `bash .claude/skills/verify/sdk-auto-compaction.sh /tmp/anthropic-1m-sdk-UNIQUE`.
The real SDK/daemon tests include Opus 5.5 with native settings and an explicit
90% session override. A loopback mocked Models API returns max_input_tokens=1000000;
SDK discovery rows go through the actual Anthropic conversion and launch path.
Evidence JSON records built CLI models, actual SDK context, daemon context,
per-model percent backstop, HTTP requests, compaction boundaries and queued receipts.
Native Opus reports 1,000,000 capacity and 967,000 native SDK threshold; applying
the daemon per-model 90% backstop to that actual response gives 900,000.
An explicit session 90% override arms a 933,000 SDK window and 900,000 threshold.
The failing reproduction commit records the old 180,000 explicit threshold.
These numbers are for the pinned SDK and fixtures, not a real-account quota test.
HTTP message model IDs must not contain the CLI's [1m] marker.

Build `bun run --cwd packages/web build`, then run:

```bash
VERIFY_ANTHROPIC_1M=1 NODE_PATH=/opt/homebrew/lib/node_modules/@playwright/cli/node_modules \
  VERIFY_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  bash .claude/skills/verify/neo-model-settings.sh /tmp/anthropic-1m-web-UNIQUE 9381 9382
```

Use the installed Playwright/browser paths for your machine. The fixture replaces
only remote discovery with documented synthetic current-model rows; conversion,
RPC, settings persistence and the built web app are real. The helper selects the
exact current model IDs rather than old fallback aliases, asserts 1M capacity,
observes `90% ≈ 900K of 1M tokens`, then saves 70% and checks `70% ≈ 700K of 1M tokens`
after desktop/mobile reload. JSON and PNG evidence live under the run's evidence/.
The launcher stops only its own children. Existing generic Settings verification
may pass with a 200K fallback catalog; that is not proof of this journey.

With 1M, a per-model percent allows much larger turns before compaction. A human
may choose a lower percent; this fix does not change defaults.
