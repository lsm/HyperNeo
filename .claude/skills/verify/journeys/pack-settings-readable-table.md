# Readable bilingual pack-setting proposals

Build the web, then run from the worktree root with a fresh synthetic directory:

```bash
bun run --cwd packages/web build
RUN=$(mktemp -d /private/tmp/hn-readable-pack-settings-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  NODE_PATH=<directory containing playwright> VERIFY_NODE=<node executable> \
  VERIFY_BROWSER=<Chromium executable> \
  bun .claude/skills/verify/pack-settings-readable-table.ts 9471 "$RUN"
```

Use a free non-8399 port. This helper owns its isolated daemon, serves the actual
built web client, and closes both servers and the headless browser in finally.
No model, provider keys, credentials, live DB or desktop GUI are used.

It opens Neo through real WebSocket RPC and proposes settings through Neo's MCP
operation adapter. For English and Chinese, the real `/neo` card must render two
repo headings and two Setting/Value tables at desktop 1280 and mobile 390 widths.
Enum names are translated, while bot logins and path patterns remain literal,
including pipes, backticks and backslashes. The mobile Apply button records a
human yes and applies exactly the stored `values_json` with human provenance.
Changing language and retrying a pending request must keep its original text.

Evidence is `evidence/observed.json`, `table-{en,zh-Hans}.json` and four matching
screenshots. Inspect the screenshots. The test-first reproduction shows raw JSON,
zero tables and fails the same render assertion. This proves daemon-owned text,
actual Markdown rendering and approval binding, not live model behavior.

The existing `pack-preference-answers.ts` restart proof now checks table text
instead of the obsolete JSON display; its replay/tamper/provenance checks stay.
