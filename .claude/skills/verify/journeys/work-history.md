# Recent Work outcomes and older history

Use the shared isolation, resources, credential refusal and cleanup in SKILL.md.
The helper owns an ephemeral daemon, synthetic projects and a manual Neo session;
no model, live DB, provider or external network is needed.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-history.ts verify
```

The same helper with `baseline` measures the previous 50-card contract before
the fix. Compare observed.json in separate evidence directories. One project has
three open asks and 32 settled asks, the other 63 open asks. Both also have old
closed-unverified work and an open question on a settled ask. Every attention
item stays visible alongside ten most recently updated finished/dropped cards.
Older history is ordered by updatedAt and id descending, pages 20 then 2 without
overlap, stays project scoped, and exposes summaries with on-demand full bodies.

Build packages/web first, then add `--web` after `verify`. Use the installed
Playwright and Chromium dependencies described in SKILL.md. The browser drives
the actual Work surface at 390/1280px: 80 initial cards, three explicit Show older
clicks reaching all 134, no further paging at the end, and exact full instructions
when an older card is expanded. Inspect browser.json and the screenshots.

For live counts, work-history-measure.ts reads the explicitly authorized SQLite
database read-only and reports only aggregated card counts and byte totals.
Those projections exclude worker/pack enrichment; observed.json instead measures
complete responses from the isolated daemon. Never call projections served bytes.
