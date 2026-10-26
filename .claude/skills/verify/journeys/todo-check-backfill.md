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
non-coding decision for Neo to set. Unit contracts cover labelled shorthand,
multiple PRs, ambiguity, checked rows, settled rows and input preservation.

For the one-off real-data pass, obtain an exported JSON array from Neo containing
id, askId, title, report, repo, state and check. Run:

```sh
bun scripts/backfill-neo-todo-checks.ts exported-todos.json > backfill-plan.json
```

The tool only reads that supplied file and writes JSON to stdout. It never opens
a database, calls a daemon or queries GitHub. Give Neo the `edits` as inputs for
neo.todo.edit after reviewing the references; give it the `unresolved` list for
checks it must choose. Unlabelled shorthand, mixed PR/issue references and
multiple distinct issues stay unresolved rather than being guessed. Keep this
private snapshot and plan out of the public repository. Applying real edits and
visual layout are outside the isolated proof and must be reported separately.
