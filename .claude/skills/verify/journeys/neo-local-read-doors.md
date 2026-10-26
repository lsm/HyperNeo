# Local read doors stay open without a paired device

Build web and use Launch in the verify skill with a fresh synthetic run
directory and a free non-8399 port. In the same shell with a stop.sh EXIT
trap, run:

```bash
node .claude/skills/verify/neo-local-read-doors.mjs 9383 "$RUN"
```

The helper drives the real daemon over the RPC door as the local user
with no paired device. neo.open opens the conversation, the asks page
reads empty, a photo read of a missing image still refuses with
image_not_found, and both device diagnostics (unpaired connections,
would-refuse requests) now answer ok instead of demanding a paired human
device. It also posts to the session-door socket as a sending session:
both diagnostics answer ok there too, while a name outside the door's
allowlist (device.pair.pending) still gets not_allowed.
Evidence: evidence/neo-local-read-doors.json.

No model/provider calls, credentials, live DB, desktop GUI or port 8399
are used. The bound Neo session reading its own conversation over the
MCP door is covered by the registry-level suites in
neo-publication-read.test.ts, neo-conversation-ask-read.test.ts and
neo-conversation-images.test.ts.
