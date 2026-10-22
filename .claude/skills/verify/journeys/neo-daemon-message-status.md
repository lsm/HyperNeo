# The daemon serves human message status to both clients

Run from the worktree root with a fresh absolute run directory:

```bash
bash .claude/skills/verify/neo-message-status.sh /tmp/hyperneo-message-status-fresh
```

Shared isolation stays in SKILL.md: NODE_ENV=test, fresh HOME/data/DB,
synthetic DB-stored credentials, a GitHub stub, and owned loopback ports.
No real provider, credential file, live database or port 8399 is used.
Helpers close all resources in finally.

Both `neo.conversation.asks.read` and human entries in `neo.conversation.read`
serve `ask.messageStatus` as one string. This additive field is shared by web
and iOS; their separate display PRs can consume it without placing turns or
inferring the first unanswered input. Existing `delivery: { state: "failed" }`
remains for compatibility. No client display change is part of this journey.
Ordinary delivery status changes emit the existing `neo.changed` refresh event
for this conversation, so clients can refetch without another human input.

| messageStatus | Daemon fact |
| --- | --- |
| received | Durable human intake with no SDK delivery/consumption evidence |
| queued | Ordinary deferred, enqueued or submitted input |
| working | Consumed input whose exact id owns the session's active, initialized processing state |
| read | Ordinary consumed input without a publication naming it, or without current active ownership |
| answered | Consumed input explicitly named by a publication's replyTo in this conversation |
| failed | Ordinary failed delivery, also exposed through the existing delivery flag |

A question citing an input does not answer it. An unrelated turn cannot make
the oldest unanswered message working. After idle, interruption or restart,
consumed but unanswered messages stay read. Legacy askOrigin and foreign
publications do not infer an answer. Image-reference reads preserve the field.
Connection freshness stays a transport fact for the clients, outside this enum.

The unit contracts call both actual operations against synthetic storage and
check every state, precise ownership, explicit selected replies, questions,
legacy and foreign publications, pagination and image-reference reads. The
installed SDK receives the stored human id. Before sending it, the fixture waits
for its earlier scheduled wake to be consumed and the session
to return idle; wake history persistence alone does not establish turn ownership.
The working assertion stays exact and does not accept another input's active turn.
While the loopback model is paused before publishing, the real RPC reports working
for that exact input. The SDK then invokes publish and ask through MCP; both reads report answered
for the explicitly published id. A later human input reaches the model and ends
without a publication; RPC reports it read while the first stays answered. The
ordinary/Neo/large-history one-restart proof also remains green.

Evidence: evidence/unit.log, sdk/evidence/neo-goal-cycle-sdk.json (including
messageStatuses, workingStatus and unansweredStatus), and
restart/evidence/spent-admission-*.json. No GUI or live
restart is claimed. The served field is verified; client rendering follows later.

## Large stored bodies preserve responsive status reads

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-status-lag-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/neo-message-status-lag.ts "$RUN"
```

The isolated daemon uses an ephemeral port and a new synthetic DB. It retains
101 SDK rows holding about 216 MB of valid message bodies, plus 100 durable human
asks. A duplicate UUID with an earlier failed delivery checks the existing
earliest-timestamp rule. Three real `neo.conversation.asks.read` RPCs must return
the complete ordered page with the expected statuses within 250 ms each, without
a one-second event-loop block. `observed.json` records RPC timings, loop lag,
row/byte counts and full before/after stored-body hashes. The helper stops its
daemon in `finally`; no provider, real DB, native sampler or port 8399 is used.
This reproduces an inefficient lookup plan, not the physical cause of the
historical 4.16 s scanner-associated block. It is a synthetic workload, not a
two-hour live rollout acceptance result.
