# Front execution

Run `neo-front-execution.ts` through `proof-run.sh` with pinned Bun. Set
VERIFY_CLAUDE to the pinned native CLI when checking a specific CLI version.
The helper owns a disposable HOME, DB and loopback model fixture on random ports.
It uses the real SDK through the ordinary session runtime.

Enable dual-model mode and send a human message through the authenticated Neo
operation. Require the daemon to present the front's tool-free terminal answer with
the original replyTo, with no acknowledgment before it. Send a second input
that the front hands to Neo with one `reply` call carrying `work_on: true` and
its acknowledgment. Require Neo's turn to offer its publish and speech tools and
to carry that acknowledgment in `<already-said>`,
then require two direct Neo publications for that input to succeed with
publishedBy neo. A third input that the front ends without a reply, whose Neo
delivery then fails, must get the fixed "could not be completed" notice.
Switch to single-model mode and preserve the same front SDK session identity.

Retain neo-front-execution.json with passed and resourcesClosed true and wrapper
exit 0. The helper closes the daemon, SDK queries, provider bridges and HTTP
fixture. This proves transport and tool behavior with scripted API responses.
