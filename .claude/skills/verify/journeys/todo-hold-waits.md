# Todo holds release on merge and return to Neo for review

Use the shared metadata-only setup in SKILL.md with Bun on PATH and an absolute,
fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-hold-waits.ts
```

The isolated daemon accepts holds and edits through WebSocket operation RPC,
then runs the production todo refresh and attention sweeps. Synthetic PR
responses replace the shared coding reader and synthetic work status keeps the
started worker stopped. The proof reads cards through `neo.ask.read` and checks
the actual digest and wake queues.

The baseline leaves an unstarted todo held after its named PR merges. The
updated daemon releases an unstarted todo and leaves a started todo ready for
its worker to continue, including after the next sweep. Each release adds one
digest. Missing and unreadable PR results leave holds in place. A merged PR
outside the hold cannot release it, and a todo's own check can still finish it.
A pending read cannot release a replacement hold. The operation refuses invalid
conditions, invalid review times and review fields on a decision card.

The helper recreates the legacy hold schema in the isolated DB and runs the
production migration. The old hold receives a wake after 24 hours. The closed
PR wake names its URL. Wake text and timing stay stable after a title edit. Repeated sweeps send one
wake per rung.

Observe `todo-hold-waits.json`, `proof.log` and `run-status.json` in the evidence
directory. The helper does not use a real PR, provider, worker or browser.
