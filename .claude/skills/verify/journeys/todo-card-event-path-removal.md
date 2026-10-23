# Per-todo card-event path removal (step 6c1)

Follow SKILL.md's shared isolation setup and the commands in
`todo-plan-recompute.md` and `coding-issue-nudges.md`. Use a fresh RUN for each,
and add `--lifecycle` to the plan helper. Run the plan before deletion and on the
exact final head. Compare its observed states, report hashes, dispatch counts
and complete synthetic worker input messages: they must remain identical.

Read only each helper's synthetic database after it exits. The final plan run
must create no `neo_card_event_subscriptions` rows. The issue helper seeds a
legacy subscription before publishing a raw CI failure: that historical row
must remain stored, and no extra worker turn may be sent. The schema and legacy
`pr_merged` claim records are preserved. Focused completion/concurrency contracts
must retain their existing fact gates; human Mark done still settles.

Observe automatic legacy PR completion and next-worker dispatch exactly once,
restart/removal/report preservation, COMPLETED advancement, NOT_PLANNED failure,
unreadable/open issues waiting, and persisted 20/40/60 nudges without blocking.
The old per-card sweep responsiveness journeys are retired because that runtime
path is deleted. Remaining dead helpers and claimed/idle/checked cleanup belong
to 6c2; do not introduce replacement subscriptions or routing.

Retain helper evidence and the before/after comparison outside the worktree,
labelled with the exact head. Helpers own and close all test daemons/listeners.
No real DB, credentials, GitHub, model, GUI or port 8399 is used. This proves
daemon RPC, persisted state and worker transport, not browser rendering or live
API-quota savings. After merge use owner-RPC build ancestry, remove the worktree
and unlink the merged PR attachment.
