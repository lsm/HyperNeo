# A provider-only Neo start stops at the identity gate

Use the shared setup in SKILL.md and the metadata-only proof wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/desktop-provider-only-start.ts
```

The helper owns a real daemon on an ephemeral port, a fresh HOME and synthetic
database. It registers no provider and starts no model turn. It seeds one open
todo and calls `work.start` as the internal Neo caller with only `provider`
named, once with the `worker.desktop` template and once without.

Pass prints `PASS: a Neo desktop-template start naming only a provider is
refused identity_required ...`. Both replies are `identity_required` naming
`missing: model, effort`, and the sessions table stays empty.

This is the only caller that carries a worker template, so the session
creator no longer picks a model from a provider alone. Starts from callers the
gate does not cover (the human door, non-Neo agents, `checkPlan`) still fall
back to the newest available model when the default cannot run; unit tests
cover that retry.
