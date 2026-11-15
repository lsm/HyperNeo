# A relayed answer goes through neo.question.answer at the session door

Use the shared metadata-only proof wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/relay-answer-door.ts
```

The helper starts a real NODE_ENV=test daemon with a fresh HOME, data directory and
database, so its session door listens in that data directory. It registers no
provider and starts no model turn. It opens a synthetic choice card twice, and
allows one relay sender through `neo.relaySenders.set` as the local user.

It then runs the real CLI, `hyperneo relay <card> --where … --when … -- pick B`,
against that door. From an unlisted sender the command fails with
`sender_not_allowed` and the card stays open. From the allowed sender it exits 0;
the card is answered by chat with `Beta`, its provenance keeps the exact words,
sender, name, place and time, and exactly one mailbox entry wakes the ask's Neo
session. `evidence/relay-answer-door.json` keeps each command's output and the cards.
