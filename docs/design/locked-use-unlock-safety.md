# Locked Use incident race

Locked Use keeps OpenAI's shipped model: unlock behind the blue cover for an authorized worker, then relock. The accepted scope is OpenAI-equivalent safety, not proofs of who unlocked, plugin versions or millisecond event ordering.

The incident has two actionable gaps. A guardian can read the still-locked state after answering Allow but before the unlock lands, then exit without a later relock. Physical owner input also does not suppress the next guardian.

## Fix 1: an answered Allow owns the exit path

The guardian records `allowAnswered` before replying Allow. From that point it treats the Mac as unlocked for lifecycle purposes, regardless of a stale lock-state read.

If the session ends or owner input interrupts it, the guardian exits only after observing the unlock and then relocking successfully. A roughly five-second cap prevents a stuck guardian: at the cap it requests an immediate lock anyway and finishes the exit path. Desktop remains Releasing until the guardian exits, so no second guardian starts in between.

The late sequence `Allow → end/input → delayed unlock → relock → exit` is covered by a headless native test with an injected lock-state source. The attended test does not try to reproduce millisecond timing.

## Fix 2: Desktop suppresses after owner input

Desktop owns a Suppressed state across guardians. Any physical owner input during or immediately after a session disarms the current guardian, suppresses further automatic unlocks, and keeps new workers refused until Desktop observes a normal manual unlock with no HyperNeo guardian present.

Desktop starts Suppressed if it is launched while the Mac is locked. On an unclean guardian exit it requests an immediate lock and enters Suppressed. A clean session without owner input does not suppress the next session. Desktop's existing single-owner gate refuses overlap; guardian crash does not return Desktop to Idle.

The guardian stays per-session. Desktop, already long-lived and the only guardian launcher, holds the cross-session state; no watcher process, socket, lock file or plugin protocol is added.

## Unchanged and out of scope

The plugin, authorization rule and installer do not change. OpenAI and `use-login-window-ui` remain alongside HyperNeo. There is no token, password hint, active input filter, version check or attempt to distinguish a late HyperNeo unlock from a correct password or OpenAI unlock: while an interrupted guardian is settling an Allow, an observed unlock is conservatively relocked, even if that occasionally asks the owner to repeat a correct password. Once no guardian or Allow is outstanding, normal password and OpenAI unlocks proceed.

## Attended signed-build acceptance

Record lock state, guardian exits, HyperNeo approvals and suppression transitions.

1. **Worker works and relocks.** Starting locked, a worker performs and reads back a real Calculator action behind the cover. Stop relocks, the guardian exits and Desktop returns to Idle.
2. **Owner input cannot unlock automatically.** During startup, under the cover and immediately after relock, move the mouse and type one or two password characters without Return; repeat with Return. After the first physical input there are zero further HyperNeo approvals until normal manual unlock.
3. **Overlap and back-to-back.** A second worker is refused while the first owns or releases the Mac. Ending with owner input and immediately requesting another session is refused with zero approvals. Two clean sessions without owner input both work and relock.
4. **Normal and OpenAI unlock.** The full password unlocks normally with Locked Use idle and while suppressed, clearing suppression. OpenAI's own Locked Use works before HyperNeo, during HyperNeo suppression and after a HyperNeo session. During suppression HyperNeo denies promptly so OpenAI and the stock password branches proceed; OpenAI relocks normally and the rule is unchanged.

The implementing PR adds the delayed-Allow native fixture and updates the Locked Use verify journey with these four checks.

## Rejected alternative

A permanent disarmed watcher guardian can hold the same state, but duplicates Desktop's lifetime and ownership. Token and branch-attribution designs exceed the chosen OpenAI-equivalent scope without fixing the two incident gaps more directly.
