# Desktop observation retention on custom endpoints

Run on the build host with the pinned Bun and the isolated wrapper from SKILL.md.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-observation-collapse.ts
```

The helper submits synthetic desktop steps to both real bridge HTTP endpoints.
It records upstream requests and compares full and collapsed bodies, the latest
failure, the order of retained target fields, the unchanged prefix and non-desktop
content, and the count request or estimate. Results without a clear status
summarize as `unknown` and leave the most recent confirmed failure in full. Pass prints
`desktop observation collapse PASS` and writes `desktop-observation-collapse.json`.

Collapse is the `desktopObservationCollapse` global setting, off by default, shown as
"Collapse older desktop observations" under Settings > Sessions & Clients > All Neo workers.
Run the [desktop call journey](desktop-call.md) without `--collapse` to check that the SDK
sends the original result and the host receives `since: latest`. With `--collapse` the
helper turns the setting on through `settings.global.update` after the endpoint's bridge
has started, so it also shows the change applies without a restart:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-call.ts --collapse
```

The SDK and synthetic host must show a collapsed older result and a full
snapshot request without `since`. The stored transcript keeps the original
result.

To check the Settings switch, build the web bundle and run the helper on a free port
(never 8399). Set `PLAYWRIGHT_NODE_PATH` to a Playwright `node_modules` when the default
is missing:

```bash
TMPDIR=/tmp/claude-501 bash .claude/skills/verify/desktop-observation-collapse-setting.sh 9347
```

It starts an isolated daemon with `launch.sh` and opens `/settings?tab=harness`. The
switch must read off with nothing stored, store `true` when pressed, still read on after
a reload, and store `false` when pressed again. It writes `collapse-setting.json` and
`collapse-setting-1280.png` and `collapse-setting-390.png`, which you look at.

This checks endpoint behavior and full-snapshot dispatch. The separate rollout
requires the recorded Calculator, TextEdit and Safari model replay in the design.
