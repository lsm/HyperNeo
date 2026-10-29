# Work search finds unloaded completed cards

Follow SKILL.md for the resource check, web build and disposable proof-run.sh
setup. Use `neo-work-search.ts global "$READY"` through that wrapper. The global
fixture adds one completed Chinese card behind sixty newer completed cards, so
the initial snapshot cannot contain it. Only the synthetic database is seeded.

Open READY.url using the browser tool. Import `verifyUnloadedWorkSearch` from
`neo-work-unloaded-search-web.mjs` in its persistent runtime and pass the tab
and an evidence directory. The helper uses the documented tab API, checks the
old card is absent before typing, searches 网页修两处 through the real UI, and
checks the completed card appears. It opens its All details dialog, verifies
古老卡片正文 is visible, and saves the resulting screenshot. Repeat at desktop
and phone widths; no history button or backend call may load the old card first.

Write browser.json under the run's evidence directory with phase global,
passed true and both observations, then signal the READY.pid with SIGUSR1.
Require wrapper exit zero and inspect the saved screenshots and cleanup receipt.
The ranked loaded-feed, retry and snapshot-refresh contracts remain in
neo-work-bm25f-search.md. This journey adds the server-backed unloaded-card path.
Live deployment acceptance remains pending while deployments are paused.
