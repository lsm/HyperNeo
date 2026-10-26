# Question cards omit stale references instead of refusing

Build web and use Launch in the verify skill with a fresh synthetic run
directory and a free non-8399 port. In the same shell with a stop.sh EXIT
trap, run:

```bash
node .claude/skills/verify/neo-question-closed-references.mjs 9382 "$RUN"
```

The helper seeds one synthetic ask in the run's DB and drives the real daemon
over RPC. A question whose replyTo names an unknown message opens with that
reference omitted. A question asked with replaces naming an answered or
retired question opens on its own and leaves the closed card untouched.
Retiring an answered or already retired question returns it unchanged. The
start question still refuses both retire and replaces, and answering a closed
question still refuses. Evidence: evidence/neo-question-closed-references.json.

No model/provider calls, credentials, live DB, desktop GUI or port 8399 are
used. Retaining valid received-human replyTo ids through a real SDK session is
covered by neo-explicit-replies.md; this journey covers the RPC door only.
