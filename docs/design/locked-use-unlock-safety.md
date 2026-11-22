# Locked Use interrupted-unlock safety

Locked Use keeps OpenAI's shipped model: a signed guardian briefly unlocks behind the blue cover, then relocks. This design changes only the incident race. It does not add tokens, read passwords, or change the authorization rule.

The guardian currently has `armed`, `unlocked` and `ending`. An authorization approval can still be in flight when `ending` sees the screen locked and exits. A later guardian can then arm immediately, including while the owner is touching the machine. The incident's second approval and subsequent unlock fit that gap.

Read-only inspection of OpenAI's installed x86_64 build found explicit `beginUnlockGuard` / `completeUnlockGuard` handling, a `pendingUnlockPhysicalInputHandler`, `interruptedUnlockThreadIDs`, `relockAfterUnlock`, and `suppressedUntilManualUnlock`. These are static symbols, not a runtime proof; they show the state transitions to copy and verify below.

## Invariant

Once the plugin has answered Allow, that attempt has a live owner until its outcome is observed. If the session is ending or physical input interrupted it, an observed unlock is followed immediately by relock; the automatic attempt finishes only after macOS reports locked. After physical input, the guardian removes the cover but remains alive and disarmed until a normal unlock with no HyperNeo attempt outstanding. A second worker never starts a guardian while the first attempt, guardian or suppressed watcher still exists.

## Threat cases

1. **Owner input before or during authorization.** The input monitor is active before the first login-window action. Input disarms immediately, marks the attempt interrupted, and sets manual-unlock-required. If Allow was already returned, the guardian does not exit on the still-locked observation: it waits for the outcome and relocks after a late unlock. No deadline counts as proof that authorization went away.
2. **Owner input under the cover or during relock.** The guardian relocks, removes the cover, reports manual-unlock-required, and stays as a disarmed watcher. It cannot grant again, and Desktop refuses later automatic starts. The watcher exits only when a normal unlock occurs with no HyperNeo grant outstanding, so input between sessions cannot be missed.
3. **Session end with authorization outstanding.** Stop, EOF and idle take the same interrupted path. The guardian stays alive through a late Allow and relock. Desktop remains in Releasing, so the next worker is refused until the guardian has actually exited.
4. **Overlapping and back-to-back workers.** The existing Desktop gate admits one owner and spawns at most one guardian. An overlapping worker gets `screen_locked`. A clean back-to-back session may start only after the prior guardian exited with no attempt outstanding. After owner input, Desktop stays in a new Suppressed state with the disarmed guardian until normal unlock; it cannot spawn a replacement.
5. **Owner's full password.** HyperNeo never reads the field. With no HyperNeo Allow outstanding, the stock `use-login-window-ui` branch handles the password normally and clears suppression.

## Changes

**Guardian** (`packages/desktop/locked-use/guardian.m`): add explicit `grantOutstanding`, `interrupted` and `relockAfterUnlock` state. Set `grantOutstanding` when the socket decides to answer Allow, before replying. On physical input or session end, disarm and interrupt; after an outstanding grant, wait for unlock and then relock before exiting. After physical input, remove the cover once locked and remain as a disarmed watcher until normal unlock. Report `manual_unlock_required` when entering that state.

**Desktop** (`packages/desktop/src-tauri/src/locked_use.rs`): keep the existing single-owner gate. Add Suppressed for the relocked, disarmed watcher: the worker has released the Mac, but no automatic start is allowed. Return to Idle only when the watcher observes normal unlock and exits. No second socket or lock file.

**Plugin, authorization rule and installer:** no changes. The existing one-of rule keeps HyperNeo, OpenAI and `use-login-window-ui` in their current order; #11527 remains intact.

## Attended signed-build acceptance

Record lock state and `io.hyperneo.locked-use` approval/denial logs for every case. Run on a Developer-ID build with the owner present.

1. **Worker works and relocks.** Lock, start a worker, perform and read back a real Calculator action behind the cover, then stop. The Mac is locked afterwards and the session has ended.
2. **Owner input cannot unlock.** Repeat during startup, under the cover, and immediately after relock: move the mouse, type one or two password characters without Return, then repeat with Return. The Mac never unlocks without the full password; after the first physical input there are no further HyperNeo approvals until normal unlock.
3. **Overlap and back-to-back.** A second worker is refused while the first owns or is releasing the Mac. End with owner input and immediately request another session while continuing the partial-entry sequence: no guardian grant and no unlock. Also run a clean back-to-back session with no owner input to prove the feature still works.
4. **Normal and OpenAI unlock.** With Locked Use idle, and again after owner input suppressed it, the full password unlocks normally. Separately exercise OpenAI's own remote Locked Use before and after a HyperNeo session; both relock, and the authorization rule is unchanged. There is no HyperNeo installer upgrade or rollback in this design.

The implementing PR adds these cases to the existing native checks and `.claude/skills/verify/journeys/locked-use-plugin.md`.

## Rejected alternative

The previous one-time-token design depended on an undocumented password-hint path and still could not distinguish a person pressing Return with the token present. Timeout-only pending grants and socket preflights likewise cannot prove an approval was discarded or ownership is exclusive. The interrupted-attempt state above closes the actual race without changing the shipped authorization model.
