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
schedule through RPC and seeds only its prior-delivery baseline. With nudgeEvery
2, ten unchanged wakes must create zero session inputs. The first two stay at
20 minutes, the third backs off to 40 minutes, then 80 minutes, up to 8 hours.
The human conversation must receive exactly one idle card on the third wake.
A real RPC goal progress update must reset the backed-off due time to 20 minutes
immediately. A second idle stretch must produce exactly one more card.

Read evidence/schedule-idle.json for each due time, count, outcome, human card,
input rows and the public conversation response. The wrapper also runs the
focused scheduler contracts. This proves the daemon and human RPC surface;
it does not claim browser rendering or real-provider execution.
