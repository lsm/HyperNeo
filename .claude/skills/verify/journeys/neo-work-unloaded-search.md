# Work search finds unloaded completed cards

Follow SKILL.md for the resource check, web build and disposable proof-run.sh
setup. Use `neo-work-search.ts global "$READY"` through that wrapper. The global
fixture adds one completed Chinese card behind sixty newer completed cards with
the same searchable fields. The old card is inserted last in the search index,
so it is beyond both the initial snapshot and the first fifty search rows.
Only the synthetic database is seeded.

Open READY.url using the browser tool. Import `verifyUnloadedWorkSearch` from
`neo-work-unloaded-search-web.mjs` in its persistent runtime and pass the tab
and an evidence directory. The helper uses the documented tab API, checks the
old card is absent before typing, searches 网页修两处 through the real UI, and
checks the old card is still absent when the first search page settles, then
clicks Load more search results and checks the completed card appears. It opens its All details dialog, verifies
古老卡片正文 is visible, and saves the resulting screenshot. Repeat at desktop
and phone widths; no history button or backend call may load the old card first.

After the opened-card check, enable the synthetic fixture's search refusal with
`curl "$ORIGIN/__verify-search-failure?enabled=1"`. Run `verifyLocalSearchFailure`
from the same browser helper: it searches needle and verifies the loaded Needle
ask remains visible alongside the server error. Reset with enabled=0 before the
next viewport. Both the refusal endpoint and database seeding exist only on the
isolated fixture; never use this endpoint on the live daemon.

Run verifyShortQueries after the opened-card check, with the refusal disabled,
to verify to do and ok? retain the loaded matching card without a false error.
The fixture's read-only `/__verify-search-stats` endpoint reports search cursors,
per-card read counts and maximum concurrent unloaded reads. Before clicking Load
more, there must be only one search page and at most fifty pointer rows to
hydrate. Maximum concurrent unloaded reads must be four or fewer. Repeating the
query and sending a changed feed event through `/__verify-refresh?changed=1`
must reuse unloaded reads; save before/after stats. Loaded changed card bodies
retain the existing revision-based refresh contract.

Write browser.json under the run's evidence directory with phase global,
passed true and both observations, then signal the READY.pid with SIGUSR1.
Require wrapper exit zero and inspect the saved screenshots and cleanup receipt.
The ranked loaded-feed, retry and snapshot-refresh contracts remain in
neo-work-bm25f-search.md. This journey adds the server-backed unloaded-card path.
Live deployment acceptance remains pending while deployments are paused.
