# Locked Use: limits and interrupted-authorization design

**No documented macOS mechanism we have found lets a worker drive arbitrary existing GUI apps while the login session remains locked.** The working Locked Use flow performs a real unlock behind the blue cover. Authorization Services also does not document the ordering of physical input, loginwindow submission and mechanism completion. Therefore this design cannot promise “works with no hole.” If zero credential-less unlock is a hard requirement, Locked Use must remain disabled.

The safest workable option is below. It closes the identified transaction, overlap and upgrade gaps where the OS provides signals, and states the remaining risk instead of hiding it.

## Transaction design

1. **Name the authorization transaction.** The plugin uses the documented `GetSessionId` callback and includes that session ID and protocol version 2 in its socket request. It sends no password or field content. The guardian accepts only one request while armed, disarms before replying, and records Allow as outstanding before writing the reply.
2. **Track completion, not a timeout.** The plugin retains the connection and reports the same session ID from `MechanismDeactivate`; `MechanismDestroy` is the fallback if deactivation did not occur. These are documented lifecycle callbacks. The guardian keeps the attempt outstanding until that completion arrives. A missing callback leaves Locked Use stuck and refuses later starts; it never treats a deadline as cancellation.
3. **Do not release the worker early.** The guardian reports `unlocked` only after both the session's completion and the screen unlock. Until then the cover stays up and Desktop refuses worker actions. If interrupted, an unlock observed before completion is conservatively treated as a possible late HyperNeo Allow: keep the cover, refuse worker access, then relock after completion. If completion arrives while still locked, a later full-password or OpenAI unlock is not HyperNeo's late completion and is preserved.
4. **Suppress after physical input.** Input disarms immediately and marks the attempt interrupted. After any required late relock, the guardian exits and Desktop enters Suppressed. New automatic sessions stay refused until the owner explicitly chooses **Resume Locked Use** while unlocked. This avoids guessing whether a password or OpenAI cleared suppression.
5. **Overlap and upgrade.** Desktop's existing single-owner gate plus one outstanding session ID prevents a second guardian from inheriting a grant. Legacy plugins send the old request and are denied; the executing protocol, not a bundle version on disk, determines eligibility. A clean back-to-back session with no input and no outstanding attempt remains allowed.

## Changes

**Plugin:** add protocol 2, the session ID, and deactivate/destroy completion on the retained connection. Deny malformed, duplicate or mismatched requests. Log request, Allow/Deny and completion with the session ID. No credential values enter IPC.

**Guardian:** add the outstanding session ID, interrupted and relock-after-unlock states described above. Keep physical-input monitoring active before the first login-window action. Never exit while an Allow is outstanding; after completion, either preserve a legitimate later unlock or finish the required relock.

**Desktop:** keep one owner. Add Suppressed and the explicit Resume control; normal unlocked desktop operation and OpenAI remain available while automatic HyperNeo unlock is suppressed.

**Installer and authorization rule:** the one-of rule is unchanged, including OpenAI and `use-login-window-ui`. The installer upgrades an older verified plugin in place through the existing verified install/rollback path, leaving the rule and backup untouched. An old plugin still loaded by macOS speaks protocol 1 and fails closed with the new guardian; a new plugin with an old guardian is also denied. No claim is made from the bundle version on disk.

## Attended signed-build acceptance

Record lock state and session-ID logs for every step. A missing required sequence is inconclusive, not a pass.

1. **Worker works and relocks.** Starting locked, the worker performs and reads back a real Calculator action only after Allow, completion and unlock for one session ID. Stop leaves the Mac locked.
2. **Owner input cannot complete an automatic attempt.** During startup, under the cover, and immediately after relock, move the mouse and enter one or two password characters without Return; repeat with Return. There must be no further HyperNeo Allow after input. Finish with the full password and confirm normal unlock; Resume only afterwards.
3. **Delayed and abandoned attempts.** Repeat startup interruption until the log proves Allow was outstanding while physical input or stop arrived with the screen still locked. The cover must remain, no worker action may run, completion must precede exit, and the late outcome must be relocked. Also capture completion without a HyperNeo unlock, then confirm full-password unlock is preserved. If either sequence cannot be produced on the signed build, its safety remains unverified.
4. **Overlap and back-to-back.** A second worker is refused while the first owns, has an outstanding session, or is suppressed; it produces zero HyperNeo approvals. A clean back-to-back session without owner input still works and relocks.
5. **OpenAI coexistence and upgrade.** Exercise OpenAI's own remote unlock before upgrade, after upgrade, and while HyperNeo is suppressed; preserve each legitimate OpenAI unlock and its relock. Verify the rule is unchanged. Exercise a failed upgrade/rollback and a legacy-protocol request: OpenAI still works and HyperNeo denies.

The implementing PR adds deterministic delayed/completed-session fixtures to the native checks and this sequence to the Locked Use verify journey.

## Residual risk and rejected alternative

macOS does not document that a physical-input event must reach the guardian before loginwindow invokes the mechanism. A person's submission could therefore win that ordering race despite immediate disarm. The current immediate-relock call and loginwindow accessibility identifiers are also private SPI, and no userspace design can guarantee relock if every responsible process dies after Allow but before relock. These risks cannot be tested away; accepting them is a product decision, not a proof of safety.

The rejected token design depended on an undocumented password-hint path and still could not identify who pressed Return. Timeout-only grants and socket preflights do not supply transaction completion or exclusive ownership.
