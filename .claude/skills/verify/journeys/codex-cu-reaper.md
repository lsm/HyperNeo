# Codex Computer Use display-sleep assertion fallback

This macOS-only driver checker automatically attempts one SIGTERM per checker per observed
PID/birth after the conservative leak predicate and final recheck pass. No
setting is needed to enable it. Explicit `codexCuAutoReap: false` through the
existing settings.global.update RPC opts out into an OS notification and log
with the single-PID action `kill -TERM <pid>`. Omitted or true means automatic.
It checks every 60 seconds, unrefs timer handles that support it, and closes with
the driver's cleanup. No live-daemon restart is part of this journey.
Driver startup with NODE_ENV=test must create no checker or OS-command timer.
Production driver registration without driverCleanup must also create no checker
timer or OS commands. The optional call short-circuits argument evaluation when
the cleanup owner is absent; retain the before/after counters in observed.json.

Deduplication is local to each checker. Same-user daemons observing the same
helper can each notify once or race SIGTERM attempts after their final rechecks.
Each checker records a failed attempt once. This slice has no machine-wide
action lock. Automatic kill-action logs record attempts only after the final
recheck passes, immediately before signalling, and never imply successful exit.

Use the shared SKILL.md resource guard and synthetic-home wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/codex-cu-reaper.ts
```

The helper replaces child_process.execFile, process.kill and timer effects
before importing the real module. Every unexpected command is refused; it
cannot call the host pmset, ps, osascript or send a real signal. It drives the
test-mode setup first and requires zero timers. Only after installing every
OS-effect replacement does it select production mode inside the isolated
helper to exercise the enabled path, restoring test mode in finally. It drives the
real 60-second callback, parses pmset and ps fixtures, and captures the actual
notification arguments a human would receive. Register the actual driver
operations with omitted, false and true settings: the default must send one
SIGTERM; only false must alert with the exact action and zero signals. Repeat
ticks must deduplicate both, including a failed notification attempt. A new
process birth may receive a new alert. Automatic mode requires a fresh second observation
and issues only SIGTERM to the exact
synthetic service PID. Young assertions, recent Created records and command
failures must issue no signal; a failed signal is attempted once, without
escalation. Concurrent ticks share one check, close clears the timer, and
non-macOS setup creates no timer. Keep observed.json and proof.log.
Close must return while an OS observation is held, with its timer cleared.
Release the held observation afterward and require zero new notifications or
signals. Closing from an action-log subscriber must also suppress the following
notification or signal. Close does not await already-running OS commands;
those retain their existing individual timeouts, and their later results cannot
cause a notification or signal after close.
Two independent checker fixtures must each notify once. A young assertion on
the final read must produce neither a signal nor an automatic kill-action log.
Register the actual driver with a numeric timer handle too: startup, the check
and cleanup must succeed without requiring an unref method.

Run the native timer lifecycle helper in both supported runtimes, with the
pinned Deno available on PATH for the second invocation:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/bun-timer-evidence \
  .claude/skills/verify/codex-cu-reaper-runtime.ts
VERIFY_PROOF_RUNTIME=deno bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/deno-timer-evidence .claude/skills/verify/codex-cu-reaper-runtime.ts
```

This uses each runtime's real timer, observes a synthetic empty assertion set
and closes the checker. No OS commands or signals run. Record the actual
runtime version and outcome instead of assuming its native timer handle shape.

Run the focused codex-cu-reaper unit suite too: five-minute boundary, ordinary
0–60-second interactions, 11–20-hour leaks, multiple assertions, recent
Created even after Released, malformed records, other users/paths/owners,
history from before process birth and a PID replacement on the final read.

This verifies synthetic driver effects, not macOS notification visibility,
actual assertion release, natural display sleep or service relaunch. Those
remain unverified until a separately approved real-machine run. First retain
assertion/log/PID-birth evidence and run the pure decision on those observations.
If no qualifying leak exists and reproducing one would require driving the
human's GUI apps, stop and report that limitation. Never signal a healthy helper
or substitute a synthetic assertion for this proof. With an approved qualifying
leak, explicitly opt out to observe alert mode first, then remove the opt-out
and wait for five minutes without a new same-name Created. Confirm only the verified helper receives
SIGTERM, assertions disappear, the display sleeps under its existing settings,
and a later real Computer Use action succeeds with an on-demand service
relaunch. Do not change power settings, kill the main app, escalate signals or
restart the human's live daemon. Exercise the checker from the candidate source.

The predicate uses the assertion history, not a global turn/admission barrier.
A new action starting between the final observation and SIGTERM can fail once;
that accepted race is not eliminated. A whole-machine Codex thread/rollout
scan remains a separate optional follow-up; this slice never opens Codex state
databases or rollouts. Malformed/unavailable power observations skip a check.
