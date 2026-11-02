# Workers stay with their open ask

Use the shared isolated setup and metadata-only wrapper in `../SKILL.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$RUN" .claude/skills/verify/worker-matter.ts
```

Use a fresh absolute RUN outside the checkout. The helper boots a synthetic daemon
on a free ephemeral port, stops its job processor, and uses the production
`work.start` and `work.find` operations with the HyperNeo adapter. It creates two
asks in the same synthetic Git folder. Finishing the first ask's todo must not
let the second ask borrow its worker. A later start for the first ask must reuse
that worker without creating a session. A human start must still create a new one. If the owned worker is temporarily unavailable,
another start for its ask must create a fresh worker rather than borrow the free human worker.

Retain `evidence/worker-matter.json` and `proof.log`. The helper closes its daemon
in finally. No provider turn or live daemon is involved. Unit contracts also cover
all terminal todo states, sticky ownership after the todo ref changes and upgrade of previously shared workers, role
isolation, model/effort selection, newest same-ask reuse and oldest-settled reuse.
Run `stalled-ask-wake.md` for the completed-ask settlement reminder and durable cooldown.
