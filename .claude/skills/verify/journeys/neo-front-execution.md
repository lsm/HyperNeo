# Front execution

Run `neo-front-execution.ts` through `proof-run.sh` with pinned Bun. Set
VERIFY_CLAUDE to the pinned native CLI when checking a specific CLI version.
The helper owns a disposable HOME, DB and loopback model fixture on random ports.
It uses the real SDK through the ordinary session runtime.

Enable dual-model mode and send a human message through the authenticated Neo
operation. Require the daemon to present the front's reply with work_on false and the
original replyTo, with no acknowledgment before it. Send a second input
that the front hands to Neo with one `reply` call carrying
its reply and work_on true. Require Neo's turn to offer its publish and speech tools and
to carry that reply in `<already-said>`,
then require two direct Neo publications for that input to succeed with
publishedBy neo. A third input ends without a Front reply. The fixture makes its
input ineligible during the Front model turn, so the real handoff admission
refuses it. Require a failed handoff outcome, failed Front SDK input status,
and no publication for that input. Require the public conversation asks reader
to report the input's failed message status and delivery state.
Switch to single-model mode and preserve the same front SDK session identity.

Retain neo-front-execution.json with passed and resourcesClosed true and wrapper
exit 0. The helper closes the daemon, SDK queries, provider bridges and HTTP
fixture. This proves transport and tool behavior with scripted API responses.

Run again with `--saturated` before the wrapper's run-directory argument. Five
synthetic refresh jobs are queued; their work stays held until the front session
consumes the human input. Require delivery within ten seconds with the refresh
work still held and no event-loop stall of one second; retain the timing, lag
samples and held count in the evidence. Restore the real refresh handler, release
the barrier and require a queued refresh to complete. This case
does not check the model reply.
