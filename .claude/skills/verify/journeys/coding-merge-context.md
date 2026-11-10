# Saved merge facts in coding context

Use shared SKILL.md isolation and resource checks. Run heavy jobs serially.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/worker-evidence .claude/skills/verify/worker-provenance.ts 0 --merge-facts
bash .claude/skills/verify/proof-run.sh /absolute/fresh/event-evidence .claude/skills/verify/pr-event-restart.ts --merge-facts
```

The worker mode extends the existing native provenance fixture. It saves coding
preferences through the real public operation, adds and binds a coding todo
through production MCP operations, and continues it through neo.todo.continue.
The actual synthetic Claude Desktop inbox writes the input into its transcript.
That delivered input must contain review_bot, hyperneo-ai-test, docs/design/**
and the effective owner merge executor. A second short follow-up names no
repository in its message: its structured PR goal must supply the repository,
and the input must reflect a newly saved daemon executor. Keep observed.json, proof.log and the
wrapper's run-status.json. Existing provenance and retained-identity checks
still run. This proves the production pack hook and native delivery path,
not provider consumption or native UI rendering.

The event mode seeds the same preferences in the isolated database, records a
real durable changes-requested transition, restarts the daemon, and runs the
production coding-pack sweep. Exactly one owner mailbox input must contain the
facts. Repeated sweeps must preserve existing acknowledgement/deduplication.
An aged owned PR then escalates to Neo; its real mailbox input must contain the
same data. Keep pr-event-restart.json and run-status.json. No model, provider,
live database, port 8399 or external service is used. Both helpers remove their
owned temporary daemon data after saving evidence.

Factory-level contracts cover worker briefs, a repository present only in the
structured work goal, case and URL/shorthand deduplication, missing settings,
unchanged saved preferences, current settings on a retried PR event, reminders,
Neo escalation and unowned PR notices. From packages/daemon, after the resource
check:

```sh
bunx vitest run --config vitest.config.ts tests/unit/1-core/operations/{coding-merge-context,neo-coding-pr-events,neo-coding-pr-sweep,neo-coding-pr-unowned,coding-pr-event-routing-db,neo-coding-pr-ledger,neo-coding-stage-facts,neo-todo-runner,neo-packs,neo-file-packs}.test.ts
```

Saved settings are descriptive data; no new instruction forbids questions or
authorizes a merge. The default executor remains owner and missing review
settings are explicit. Notification reads use the existing DB gateway; the
synchronous worker hook reads through the same repository policy reader.
Browser layout, real GitHub decisions and deployed behaviour are unverified.
