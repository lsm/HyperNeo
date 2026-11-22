# Locked Use incident race

Locked Use keeps OpenAI's shipped unlock-behind-cover mechanism. Only the incident race changes.

The iMac rule is one-of HyperNeo, OpenAI remote unlock, then `use-login-window-ui`. Read-only inspection found OpenAI's persistent XPC guardian, per-thread begin/complete guards, pending and interrupted IDs, `relockAfterUnlock`, `suppressedUntilManualUnlock`, and `SystemLockScreenController.authorizeUnlock(withGuard:) -> Bool`. Its input tap is also passive listen-only (`options=1`), so OpenAI does not establish pre-delivery input blocking; its relevant protection is persistent attempt state and suppression after observed input. HyperNeo currently loses that state when one guardian exits and another starts.

## Design

1. **One guardian for Desktop's lifetime.** Desktop reuses one signed guardian for sequential sessions. End removes the cover after relock but keeps the process and its pending/interrupted state. Overlapping workers are refused; Desktop exit still closes stdin, relocks and exits the guardian.
2. **Block physical submission while armed.** Arm before touching loginwindow and use an active event filter only while armed. On physical input, set interrupted/disarmed synchronously and return `NULL`, dropping the event before loginwindow can submit it. The tap and socket decision remain on one run loop, and the socket checks the flag without yielding. Once disarmed, return to passive listen-only so subsequent full-password input works normally. OpenAI's passive tap is insufficient for this specific guarantee.
3. **Separate attempt result from Allow settlement.** One `authorizeUnlock(withGuard:)` routine returns `didUnlock` for its own submission and verification. A false result without an Allow completes the attempt. A false result after Allow does **not** prove abandonment: keep that Allow outstanding and the next worker blocked. Any unlock while an interrupted Allow is outstanding takes `relockAfterUnlock`; only the observed outcome and required relock settle it. Unknown outcomes never clear through a timeout or an independent password/OpenAI transition.
4. **Suppress after input and relock.** Observed input disarms and suppresses further automatic attempts until normal manual unlock. A late successful outcome keeps the cover and worker block through relock. An independent unlock with no Allow outstanding is preserved. With an Allow outstanding, the guardian conservatively relocks rather than guessing that password or OpenAI caused it.
5. **No inheritance.** Back-to-back sessions reuse the same guardian PID with new session IDs only after the prior attempt settled and suppression cleared. There is no second guardian to inherit an Allow or miss input between processes.

## Changes

**Guardian:** persist across worker sessions; add active-only-while-armed input filtering, per-session begin/complete, outstanding-Allow settlement and manual-unlock suppression. No passwords enter IPC.

**Desktop:** retain the guardian and single-worker gate; expose manual-unlock-required instead of spawning a replacement after input.

**Plugin, authorization rule and installer:** no changes. OpenAI coexistence and the existing backup stay untouched.

## Attended signed-build acceptance

Record guardian PID, session IDs, input decisions, Allow, `didUnlock` and lock state. Missing evidence is inconclusive.

1. Starting locked, a worker performs and reads back a real Calculator action; stop relocks and the same guardian remains alive.
2. During startup, under the cover and immediately after relock, move the mouse and enter a partial password with and without Return. While armed, the events are dropped before delivery and no HyperNeo Allow follows. Afterwards the full password passes the passive tap and unlocks normally.
3. Capture a delayed Allow interrupted before its outcome: the cover and worker block remain through completion and relock, and an immediate second worker produces zero approvals. Capture a false/unknown outcome after Allow and an independent unlock: the next worker stays blocked and the ambiguous unlock is conservatively relocked, never relabelled as manual or OpenAI. A false outcome with no Allow may complete normally.
4. An overlapping worker is refused. Clean back-to-back sessions use the same guardian PID and never inherit an attempt. OpenAI remote unlock works before and after HyperNeo, and during suppression with no HyperNeo Allow outstanding. After OpenAI relocks, HyperNeo remains suppressed and produces zero approvals until the full-password flow clears it.

The implementing PR adds delayed/interrupted fixtures and these cases to the native checks and Locked Use verify journey.

## Rejected alternative

A fresh guardian per session loses late-Allow and input state. A passive-only tap cannot stop a person's Return from reaching loginwindow first, and a timeout or unrelated unlock cannot prove an Allow was abandoned.
