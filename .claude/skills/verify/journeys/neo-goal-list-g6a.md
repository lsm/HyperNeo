## Neo goal list (G6a)

Build the web, launch a fresh isolated daemon, then run
`bun .claude/skills/verify/neo-goals-web.ts <port> "$RUN"` and the headless
`neo-goals-web.mjs <port> "$RUN"` with the same Node/Playwright/VERIFY_BROWSER
setup as the web schedule journey. Synthetic goals and journal entries are made
through real RPC: measured, paused, closed and another session's private goal.
No provider is configured and no model is called.

On `/neo` at 1280px, the Goals section must sit beside Your work. At 390px, open
Your work to reveal it. Both show only the root's two current goals, a 30% progress
bar, a done-test, the next wake matching the real schedule RPC, no wake for the
paused goal, and only the latest journal effect. A new journal entry through RPC
must appear on explicit refresh. Completing both goals through RPC and refreshing
must remove them and show the successful empty state. Inspect
`evidence/neo-goals-{1280,390,empty}.png` and `neo-goals-web.json`.

Component contracts cover loading/error versus empty, retry, journal refusal,
focus refresh, stale owner reads and Chinese labels. Goal detail, home links,
what-works notes and paginated journal evidence remain G6b; this journey does not
claim them. Stop the isolated daemon/mock with `stop.sh`; the browser closes itself.
