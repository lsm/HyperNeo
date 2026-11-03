# Codex Computer Use display-sleep assertion fallback

This macOS-only driver checker defaults to an OS notification and log with the
single-PID action `kill -TERM <pid>`. Set `codexCuAutoReap: true` through the
existing settings.global.update RPC only after human approval to opt into one
automatic SIGTERM per observed PID/birth. Omitted or false means alert only.
It checks every 60 seconds, without keeping the process alive, and closes with
the driver's cleanup. No live-daemon restart is part of this journey.

Use the shared SKILL.md resource guard and synthetic-home wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/codex-cu-reaper.ts
```

The helper replaces child_process.execFile, process.kill and timer effects
before importing the real module. Every unexpected command is refused; it
cannot call the host pmset, ps, osascript or send a real signal. It drives the
real 60-second callback, parses pmset and ps fixtures, and captures the actual
notification arguments a human would receive. Default alerts contain the
exact one-line action with zero signals; repeated ticks deduplicate it. Opt-in
requires a fresh second observation and issues only SIGTERM to the exact
synthetic service PID. Young assertions, recent Created records and command
failures must issue no signal; a failed signal is attempted once, without
escalation. Concurrent ticks share one check, close clears the timer, and
non-macOS setup creates no timer. Keep observed.json and proof.log.

Run the focused codex-cu-reaper unit suite too: five-minute boundary, ordinary
0–60-second interactions, 11–20-hour leaks, multiple assertions, recent
Created even after Released, malformed records, other users/paths/owners,
history from before process birth and a PID replacement on the final read.

This verifies synthetic driver effects, not macOS notification visibility,
actual assertion release, natural display sleep or service relaunch. Those
remain unverified and require separate human approval on a disposable test
Mac: retain assertion/log/PID-birth evidence, induce a leak in a sacrificial
session, wait for five minutes without a new same-name Created, observe alert
mode first, then approve opt-in. Confirm only the verified helper receives
SIGTERM, assertions disappear, the display sleeps under its existing settings,
and a later real Computer Use action succeeds with an on-demand service
relaunch. Do not change power settings, kill the main app, escalate signals or
run this test on the human's live daemon without that approval.

The predicate uses the assertion history, not a global turn/admission barrier.
A new action starting between the final observation and SIGTERM can fail once;
that accepted race is not eliminated. A whole-machine Codex thread/rollout
scan remains a separate optional follow-up; this slice never opens Codex state
databases or rollouts. Malformed/unavailable power observations skip a check.
