## A spent query cannot suspend delivery admission after a deploy restart

Run `bash .claude/skills/verify/spent-admission-restart.sh "$RUN"` with a fresh
absolute run directory. Shared isolation rules are in SKILL.md. The helper runs
an isolated test daemon and real SDK against an ephemeral loopback model server;
provider credentials exist only in its synthetic DB, GitHub is stubbed, and the
live daemon is never called. No GUI or real provider traffic is exercised.

The ordinary-session control and Neo both first consume a kickoff. The helper
stops only its daemon, marks that synthetic input pending for recovery, queues
a system input with origin `space_inject` plus four more inputs, then restarts
against its own DB/SDK history. The model records actual queued markers. Neo's
head must reach `query_ready` while its session becomes idle. `client.interrupt`
must preserve all queued inputs. Every marker must subsequently reach the model
and every queued row must become consumed without another restart or send.

The existing admission timeout is set to 3000 ms for the proof. Evidence in
`$RUN/evidence/spent-admission-{ordinary,neo}.json` records RPC receipts, job
stages, timestamps, input statuses and actual model receipts. The test closes its
daemon, SDK, WebSocket and model server in finally, including on failure.
A timeout firing alone does not pass; queued input receipt is required.
