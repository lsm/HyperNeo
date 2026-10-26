# Work cards defer full bodies until opened

Use shared setup and resource guards in SKILL.md. The isolated RPC helper owns
an ephemeral daemon and synthetic 181-ask fixture, without a model or provider.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-card-summaries.ts verify
```

Before the fix, run the same helper with `reproduce`. Compare observed.json:
The original reproduction has 50 cards and 231 todo rows. Current retention
includes 60 cards (every attention-needed ask plus ten recent outcomes), keeping
all 231 todo rows; instruction/report bodies and answered questions no longer
travel with each snapshot. neo.ask.read must still return
the exact full instruction. Neither mode reads the live database.

For the read-only live tally, pass the explicitly authorized DB and an evidence
destination to work-history-measure.ts. It uses production card projections,
emits only aggregated counts/bytes and opens SQLite read-only. Its byte totals
cover todoAsks without pack or worker enrichment, not the entire served snapshot.

Build packages/web, set NODE_PATH to existing Playwright dependencies and
VERIFY_BROWSER to an installed Chromium executable, then run:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/web-evidence-directory \
  .claude/skills/verify/work-card-summaries-web.ts
```

The browser checks the actual /neo Work surface at 390 and 1280 pixels: waiting state and counts remain visible; question text and choices load only
after opening the card; no detail RPC runs until a row is expanded;
the expanded row displays full instructions and report; answering the question
removes its buttons. Choice selectors use the rendered letter-prefixed labels
(for example A Ship), matching the production option labels. Inspect summary/detail PNGs and browser.json. Native iOS
is outside this journey; clients use summary counts and neo.ask.read on expand.
The shared question stays open across both viewport checks and is answered only
after the final one. Summary question reply quotes use the owning card's bounded
title without sending question bodies; wake question links must load and focus
the full question via its summary reference. Paired relays can read full cards
through neo.ask.read but cannot mutate work; paired-device and snapshot tests
cover that admission boundary.

The browser fixture also has 21 completed todos beyond the RPC window. Its closed
card must say 22 todos alongside the 21-done paging control. At desktop width the
browser holds one real detail response while editing an unsent draft, then releases
it and checks the full bodies arrive without another read. A second opening injects
a failed detail response; editing the draft must retain its error without retrying.
Only those detail replies are delayed or failed; all snapshots and other RPCs use
the isolated daemon. Inspect failed-read-1280.png as well as summary/detail images.
