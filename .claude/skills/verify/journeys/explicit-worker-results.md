# Explicit dispatch-bound worker results

Use the shared isolation rules in SKILL.md. No provider, model, GUI or HTTP mock
is needed. The helper owns a real daemon on an ephemeral non-8399 port, a fresh
home/database, a refusing GitHub fixture executable and a synthetic Codex Unix
socket. It seeds only synthetic sessions and SDK input/result facts.

```bash
RUN=$(mktemp -d /private/tmp/hn-explicit-results-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/explicit-worker-results.ts verify "$RUN"
```

The actual driver-refresh job and `work.status` path must retain the previous
report when a legacy worker has no dispatch receipt, even though its input
opening matches and its prose says complete. Matching receipt evidence must
store every report byte, including whitespace and Unicode, and exclude a later
unrelated turn. The coding todo stays doing while its PR is open; an explicit
`neo.todo.close` attempt cannot substitute the worker's claim for pack facts.
A non-pack todo stays doing until explicit human confirmation via the close
operation, retaining the same report bytes.

Repeat refresh, remove the legacy todo through RPC, and reopen the daemon. The
removed todo stays removed with its old report; the receipt-bound report remains
identical. Only after the fixture PR merges may the pack finish its todo and
actually dispatch the next worker through `turn/start`. The helper requests an
explicit fact recheck through the close operation, bypassing the normal check
interval; the earlier identical request while the PR was open was refused. Repeating the fact sends
nothing twice. Logical SDK input/result bytes remain unchanged across the daemon
restart (normal body-split storage maintenance may relocate their physical rows). Stored states and real
`neo.snapshot` RPC replies are saved in `evidence/observed.json`, alongside actual
worker peer calls and report byte/hash evidence; `evidence/gh.log` shows fixture
reads. The helper closes its daemon, RPC socket and worker peer in finally. The
synthetic Neo has no provider: informational note consumption is not verified.

`before` mode on the pre-change revision reproduces the bug: an opening-matched
result without a receipt replaces the previous report. Contract tests cover the
other deleted routes (latest-reply/grace and quiet-hours unanchored inference),
wrong execution/input receipts, malformed/unavailable evidence, valid failure
results and complete report/follow-up bytes. Existing report-attribution tests
also cover full assistant pages and split-body storage. This journey proves the
worker-result operation surface, not GUI rendering or model note consumption.
