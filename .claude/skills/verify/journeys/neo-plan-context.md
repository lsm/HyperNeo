# Retain open plans through snapshot indexes

Use SKILL.md shared pinned runtime, dependency and resource setup. From the
owned checkout, run this metadata-only proof with the shared wrapper.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-plan-context.ts verify
```

It owns a fresh keyless NODE_ENV=test daemon on a random port excluding 8399/8499,
a synthetic local RPC client and the actual agent MCP handler. It seeds 12 local
asks, 480 unfinished steps and 12 questions, with no domain checks or configured
domain client. A refusing executable records any attempted domain-client call.
No provider or model turn is needed for this data-projection slice.

The ordinary RPC snapshot contains all 12 owners. The agent MCP snapshot retains
all 12 open owners with card summaries and open questions. Snapshot text has no
byte budget. Instrumentation must observe zero target-table reads on the main
connection during both snapshot and gateway plan reads. The new read must
return 12 asks, 480 family steps and 12 questions. The fitted digest must keep all
12 headers, naming neo.ask.read and each owner's id for omitted steps. A full
compact-source digest includes the last owner and an unchanged prompt emits no
context. Any domain-client invocation fails the proof.

The same run seeds three Neo-owned inputs. One is answered by a publication that
replies to it, one by a card reply that records it in `cardReply.sourceMessageIds`,
and the third is not answered at all. `planContext` must return only the third,
with its full message id and text. The compact-source context and the real
`SessionStart` hook in compact mode must contain that id and text and omit both
answered ones; a startup-source context must omit all three. A plan read without
the compact flag must not carry the unanswered list at all, so per-prompt reads
skip that scan. The section itself is bounded: entries are capped at 2 kB, the
section at 8 kB oldest-first, and anything left over is announced with a pointer
to `neo.conversation.read`.

Before the fix, run the identical helper in before mode on the baseline. It must
fail the real MCP open-owner assertion, retaining observed.json with the smaller
owner list. The wrapper saves evidence and removes the temporary daemon data
when the helper exits, including failure. The helper closes the client transport, clears its hub and closes the daemon
in finally. Unit command tests retain their portable inline gateway seam; this
isolated native daemon proves actual worker execution. Inspect run-status.json rather than trusting a PASS line alone.

Mandatory owner headers take priority over the requested budget when even the
headers alone exceed it. Unit tests pin this floor as well as UTF-8 byte sizing,
question counts, prerequisite/hold readiness, change-only context and closures.
The same proof also seeds a legacy two-generation family. The gateway must
return each step once. The fitted per-turn plan digest must retain some step details
within its byte budget. Detail admission measures the serialized objects and
array separators, including the omission guidance, rather than digest text.
Run snapshot-index, ask-entry summaries, the refusal-catalog audit
and the storage reader-worker regression, then
check:neo-pack-imports and check:db-main-thread. New core files contain no domain
vocabulary. Per-turn SDK delivery and streaming-hook behavior belong to 7-B.
