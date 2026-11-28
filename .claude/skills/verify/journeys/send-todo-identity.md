# New todo work names provider, model and effort

Use the shared setup in SKILL.md and the metadata-only proof wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/send-todo-identity.ts
```

The helper owns a real daemon on an ephemeral port, a fresh HOME and synthetic
database. It registers no provider and starts no model turn. Through the
production MCP handler as Neo:

- `neo.todo.add` with a local HyperNeo start target missing provider, or a send
  target missing the whole triple, is refused `identity_required` naming the
  missing fields, and no todo is added.
- A remote start target keeps today's admission (no `identity_required`).
- A send target naming the triple is stored with it.
- `work.send` and `work.queue` giving the seeded worker a todo it is not running,
  without the triple, are refused `identity_required` with `notSent: true`.
- The same send naming a triple is refused unsent. The synthetic daemon has no
  model catalog, so this reads `unsupported_model`; the recorded-identity
  mismatch (`identity_required`) is covered by the work-send-identity unit test,
  not by this journey.
- No delivery input is recorded for any refusal.

The saved observed.json holds every reply and the stored target rows.
