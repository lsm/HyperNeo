# Unowned PRs and stalled owners reach Neo once

Use the shared metadata-only wrapper and resource guard from SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/unowned-pr-claims.ts
```

The helper owns an ephemeral daemon, disposable HOME/DB, refusing GitHub stub
and authenticated local RPC. A persisted synthetic job runs the production
coding-pack sweep, and every Neo-facing wake goes through the real
`neo.attention.tell` entry into Neo's mailbox.

The first wake is refused, so nothing is admitted. Then a current owner claims
one PR, and the public neo.todo.edit addUrls operation links a second PR to an
unassigned todo. After a daemon restart the next sweep must put exactly one
message in the mailbox, for the third PR. Further sweeps and another restart add
nothing: the pack keeps no record of what it told, and the entry refuses the
same message. A fourth PR is told once on its own. Removing the todo releases
its claim, and that PR is then told once.

The owner of the first PR then becomes unreachable while the PR conflicts with
its base. Twenty minutes later the PR sweep escalates to Neo's mailbox once,
with the time the state began. The helper clears the ledger's reminder count to
stand in for a lost write; the next sweep raises the escalation again and the
mailbox still holds one.

Main-thread SQL guards cover the unowned read and the claim lookup. Keep
unowned-pr-claims.json and proof.log with exit status and resourcesClosed=true.
This proves production selection, public link editing and once-only mailbox
admission with synthetic repository reads and refused-delivery injection.
No model, real GitHub request, GUI or live daemon is used. The daemon, service
and socket are closed in finally.
