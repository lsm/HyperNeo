# Idle schedules back off without model turns

Run `bash .claude/skills/verify/session-schedule-idle.sh <fresh-absolute-dir>`
from the worktree root, using the shared in-process RPC-proof setup in SKILL.md.
No HTTP model ports or provider registration are needed: unchanged wakes must
never enqueue a model input. The helper owns an isolated NODE_ENV=test daemon,
HOME/data/DB and an ephemeral RPC port, with a GitHub stub and no real keys.
It closes the daemon and restores the clock in finally.

The helper captures the actual registered schedule handler without replacing
its decisions, stops automatic job polling, and advances a fake Date.now to
one due job at a time. It creates an ordinary session and a 20-minute goal
schedule through RPC and seeds a consumed historical human input plus the old
raw source-digest baseline and mixed due-run count. It runs the real upgrade
migration; with nudgeEvery 2, ten unchanged wakes must add zero session inputs. The first two stay at
20 minutes, the third backs off to 40 minutes, then 80 minutes, up to 8 hours.
The human conversation must receive exactly one idle card on the third wake.
A real RPC goal progress update must reset the backed-off due time to 20 minutes
immediately. A second idle stretch must produce exactly one more card.

Read evidence/schedule-idle.json for each due time, count, outcome, human card,
input rows and the public conversation response. The wrapper also runs the
focused scheduler contracts. This proves the daemon and human RPC surface;
it does not claim browser rendering or real-provider execution.

The review regression checks that unrelated session/settings/inbox writes and an
unrelated session's message event trigger zero source-facts reads. Focused
contracts also upgrade legacy mixed due-run counts, observe a fresh first/third
quiet wake, and confirm a later restart preserves the quiet count. The web
component check asserts the schedule strip promises no forced nudge.

Upgrade contracts cover no history, human input, an ask, and a todo. The first
post-upgrade unchanged wake must skip without a model turn; the third emits the
idle card. Later startup migrations must preserve both the converted baseline
and the new quiet count. Actual source changes still fire and reset as before.

A progress reset followed by a reversion to the previous facts is still a new idle
stretch. Rename the session before that stretch: its third quiet wake must publish
one new card using the current name and no model input. Card retry identity uses
the third wake's scheduled due time, so reverting facts cannot reuse an old card.
Progress-reset labels are localized in both English and simplified Chinese.
