30. **Scheduled wakes are quiet web disclosures (G5b).** Build the web and launch a
    fresh isolated daemon. Run `bun .claude/skills/verify/neo-wake-web.ts <port> "$RUN"`
    to seed synthetic active, settled-with-additions and settled-empty wakes, then
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-wake-web.mjs <port> "$RUN"`.
    Like journey 18, `VERIFY_BROWSER` can select a headless Chrome executable.
    `/neo` must show closed clock/title/summary/time rows; the active one reads
    Working. Attributed publication detail appears once, inside its wake. The publication link must resolve to its rendered article (recorded in
    `neo-wake-{desktop,mobile}-publication-link.json`). The summary is selectable text and does not toggle. Only the shared bottom-right
    more/less button opens or closes the row. Opening it exposes labelled additions; following its question link reveals the
    original question in Your work on desktop and in the mobile sheet. A removed
    todo link opens its owning ask’s Details before scrolling to the retained row. Questions
    remain independently answerable; journal labels are text until G6 supplies a
    journal destination. Screenshots `neo-wake-{desktop,mobile}-{collapsed,expanded,question}.png`
    and observed text `neo-wake-web.json` live in `evidence/`. No model turn, real
    provider, real data or desktop GUI is exercised. Stop with `stop.sh`.

    For history folding, use another fresh isolated run. Seed with
    `bun .claude/skills/verify/neo-wake-pagination.ts <port> "$RUN"`, then run
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-wake-pagination.mjs <port> "$RUN"`
    (`VERIFY_BROWSER` works here too). Its 51 retained publications put the wake
    just outside the initial history window. Clicking Load earlier folds the
    topmost publication into its newly visible closed wake; that wake must retain
    the publication's viewport position on desktop and mobile. Closed descendants
    can report nonzero cached rectangles in Chrome, so visibility is determined
    by the disclosure, not height alone. Repeated already-rendered text isolates
    folding from unrelated later Markdown reflow; that reflow is not fixed here. Evidence: `neo-wake-pagination.json`
    and `neo-wake-pagination-{desktop,mobile}-{before,after}.png`. Stop the run.
