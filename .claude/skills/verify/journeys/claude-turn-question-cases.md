# Claude turn-ended question cases

Use the shared metadata-only isolated daemon setup in SKILL.md. Set
`VERIFY_PROOF_PREFIX=r-` and `TMPDIR=/private/tmp` so the synthetic worker sockets
stay within the macOS path limit.

```sh
TMPDIR=/private/tmp VERIFY_PROOF_PREFIX=r- bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/claude-turn-question-cases.ts
```

Real Desktop adapter reads, a real `NeoService` and operations, and synthetic
workers on Unix sockets that write `wrap_up` transcript lines. Neo notifications
are read from its real durable mailbox jobs. A local-human WebSocket client reads
the actual card and submits its answer through operation.invoke. Neo's choices
are scripted operation calls; no model runs. The cases cover Neo answering, the
human card, sessions with no todo, repeat questions, the 2-minute rule, answers
made in Desktop, stale questions, `blocked` with no `ask`, tail and compaction
edges, and a real permission prompt. Evidence is `observed.json` and `proof.log`.

The synthetic CLI serves agents --json from its prepared snapshot through cat,
avoiding a fresh Bun startup for each listing under load. Inbox transport and
transcript parsing still run through the real adapter. The worker must produce
a follow-up reply after the human answer, not merely accept an inbox frame.

A held inbox writes the actual queue-operation enqueue shape so an accepted
reply clears the old question before consumption. The scheduled reminder case
uses the real schedule delivery and fire pipeline and observes the next worker reply.
