# Question cards follow checked facts

Use shared SKILL.md setup and the guarded metadata-only wrapper:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/question-retire-when.ts verify
```

The helper owns a real isolated daemon with a fresh HOME/data directory and an
ephemeral non-8399 port. It refuses external HTTP and GitHub, configures no
provider, and stops background processing before seeding synthetic work. A
startup observer captures the actual Neo service without replacing its checks,
retirement, delivery or public operation handlers.

Observe real WebSocket `neo.question.ask` receipts: an unlinked card without
retireWhen is refused with a clear message. A supplied already-done todo cannot
silently turn that request into an unchecked unlinked card. Unknown packs, unsupported kinds and malformed params are refused through the
same pack policy as todo checks. With explicit
`retireWhen: {pack, kind, params}`, the same request opens an unlinked card and
blocks a waiting todo. Run the actual pack sweep: the missing evidence file
leaves that card open and the hold intact. Create the synthetic file and sweep
again. `neo.question.get` and `neo.ask.read` must show retirement with the check's
evidence, no fabricated human answer, and a released todo. One mailbox line
informs Neo; another sweep must not duplicate it.

Keep `observed.json`, `receipts.json`, `proof.log` and the wrapper's real exit
status. Focused tests cover linked-check defaults, explicit overrides, failed
reads, concurrent sweeps, changes during a read, release rollback and restart.
An unlinked coding check also uses the pack's existing check without inserting
a fictional todo or saving todo-only cache rows. Other packs can use the same
optional question context to avoid todo-only side effects.

This is daemon/operation proof. It does not claim browser layout, provider or
live-database verification. The helper closes its WebSocket and daemon in
finally; the wrapper retains evidence before removing synthetic data.
