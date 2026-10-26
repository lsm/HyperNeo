# One-off legacy todo completion-check plan

Use the shared isolated metadata-only setup. This helper owns an ephemeral
loopback daemon port, a fresh HOME/data/database and a refusing GitHub stub. It
has no model, provider or credentials and closes its WebSocket and daemon in
finally. The wrapper preserves evidence and immediately removes temporary data.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-check-backfill.ts verify
```

The baseline fails because no offline backfill CLI exists. The fixed helper
exports synthetic unchecked rows, invokes the CLI, and applies its PR/issue
repair inputs through the real WebSocket neo.todo.edit door. The returned todo
and persisted row must carry the derived check and completion sentence. Other
state stays open. A repeated export yields no further edits and still lists the
non-coding decision for Neo to set. A supplied synthetic kind map resolves an
unlabelled named reference and its bare sibling into two required PRs; an
unknown reference remains unresolved. Unit contracts cover labelled shorthand,
multiple PRs, supplied reference kinds, inferred repository context, ambiguity,
checked rows, settled rows and input preservation.

For the one-off real-data pass, obtain an exported JSON array from Neo containing
id, askId, title, report, repo, state and check. Run:

```sh
bun scripts/backfill-neo-todo-checks.ts exported-todos.json ref-kinds.json > backfill-plan.json
```

Omit the second filename when no observed kinds are available. The optional
second file is a trusted observed reference-kind map, for example
`{"example/project#50":"pr","example/project#9":"issue"}`. Supply it from a
separate metadata observation, never infer types from completion prose. A bare
number uses the stored repository or the sole explicit repository named in that
todo's title/report. Unknown kinds, missing facts and multiple possible
repositories remain unresolved.

The tool only reads the supplied files and writes JSON to stdout. It never opens
a database, calls a daemon or queries GitHub. Give Neo the `edits` as inputs for
neo.todo.edit after reviewing the references; give it the `unresolved` list for
checks it must choose. Unlabelled shorthand without observed kinds, mixed
PR/issue references and multiple distinct issues stay unresolved rather than
being guessed. Keep this
private snapshot and plan out of the public repository. Applying real edits and
visual layout are outside the isolated proof and must be reported separately.
