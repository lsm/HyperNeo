# Locked Use incident race

Locked Use keeps the shipped OpenAI-style mechanism: unlock behind the blue cover for an authorized worker, then relock. Only the incident race changes.

The iMac's rule is one-of HyperNeo, OpenAI remote unlock, then `use-login-window-ui`. Read-only inspection of OpenAI's installed bundle found a persistent XPC guardian with per-thread `beginUnlockGuard` / `completeUnlockGuard(didUnlock)`, `pendingUnlockThreadIDs`, auto-unlocked leases, `pendingUnlockPhysicalInputHandler`, `interruptedUnlockThreadIDs`, `relockAfterUnlock`, and `suppressedUntilManualUnlock`. These static symbols show the relevant difference: OpenAI keeps one guardian across turns and retires each attempt explicitly; HyperNeo currently exits after relock and may start another guardian with no memory of the prior attempt or owner input.

## Design

1. **One guardian for Desktop's lifetime.** Desktop starts the signed guardian once and reuses it for sequential Locked Use sessions. Session end removes the cover after relock but does not exit the guardian. Desktop still admits one worker; an overlapping worker is refused. Desktop exit closes stdin, and the guardian relocks and exits as today.
2. **Explicit attempt ownership.** Each automatic attempt registers a session ID with `beginUnlockGuard`. The unlock runner finishes it exactly once with `completeUnlockGuard(sessionID, didUnlock)`. An Allow remains outstanding until that completion. If the outcome is unknown, the guardian remains pending and the next worker is refused; a timeout never proves abandonment.
3. **Physical input interrupts and suppresses.** Input disarms immediately, moves pending IDs to interrupted, and suppresses further automatic attempts until normal manual unlock. A late `didUnlock=true` takes `relockAfterUnlock`: the cover stays, the worker remains blocked, and the guardian relocks before releasing the attempt. `didUnlock=false` retires an abandoned attempt without inventing a relock.
4. **No inheritance after relock.** The same guardian retains pending, interrupted and suppression state after the cover comes down. A back-to-back session gets a new session ID only when the prior attempt completed and suppression is clear. A second guardian is never spawned, so it cannot inherit an outstanding Allow or miss owner input between processes.
5. **Normal and OpenAI unlock remain independent.** While disarmed, HyperNeo denies and the stock password or OpenAI alternative proceeds normally. A screen transition is not used as proof that a pending HyperNeo attempt completed; the explicit `didUnlock` result owns that decision.

## Changes

**Guardian:** become a Desktop-lifetime process handling sequential session IDs, explicit begin/complete, interrupted attempts and manual-unlock suppression. Keep the existing plugin socket and physical-input monitor; no passwords enter IPC.

**Desktop:** retain and reuse the guardian, keep the single-worker gate, and expose manual-unlock-required instead of starting another guardian after owner input.

**Plugin, authorization rule and installer:** no changes. OpenAI coexistence and the existing rule backup stay untouched.

## Attended signed-build acceptance

Record guardian session IDs, Allow/Deny, completion, lock state and guardian PID. A missing sequence is inconclusive.

1. Starting locked, a worker performs and reads back a real Calculator action behind the cover; stop relocks and the same guardian remains alive.
2. During startup, under the cover, and immediately after relock, move the mouse and enter a partial password without Return, then repeat with Return. No post-input HyperNeo Allow or unlock occurs. The full password afterwards unlocks normally and clears suppression.
3. Capture a delayed Allow with input or stop arriving before completion: the cover and worker block remain until completion and relock, and an immediate second worker produces zero HyperNeo approvals. Also capture `didUnlock=false` for an abandoned attempt and preserve the following full-password unlock.
4. An overlapping worker is refused. Back-to-back sessions use the same guardian PID and new session IDs, never inherit an outstanding attempt, and relock afterwards. Exercise OpenAI remote unlock before and after HyperNeo, and once while HyperNeo is suppressed; each legitimate OpenAI unlock and relock still works and the rule is unchanged.

The implementing PR adds delayed/interrupted attempt fixtures and these cases to the existing Locked Use native checks and verify journey.

## Rejected alternative

Spawning a fresh guardian after relock loses the only state that can identify a late Allow or intervening owner input. Tokens, password hints, timeout-only completion and socket preflights change the shipped mechanism without supplying that missing ownership.
