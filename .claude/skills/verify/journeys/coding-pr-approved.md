# PR approval follows the repository’s saved policy

Use shared SKILL.md isolation and the guarded wrapper:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/coding-pr-approved.ts verify
```

The helper owns a real daemon on an ephemeral non-8399 port, fresh HOME/data,
a synthetic Neo session and a refusing gh executable that answers only this
run’s PR-head, paginated-review and required-check metadata. External HTTP is
refused; no provider, credentials, model, live GitHub or live database is used.
Its startup observer captures the actual Neo service without replacing checks,
retirement or operation handlers. Background jobs and coding-ledger sweeps are
stopped; installed coding checks still run through the actual todo runner and
question sweep. The public saved-preference operation configures only this run.

Observe real neo.todo.add check and neo.question.ask retireWhen receipts for
{pack:"coding",kind:"pr_approved",params:{url}}. Wrong-bot or old-head approval
leaves both open. The configured bot’s current-head approval completes the todo,
retires the unlinked card with full-head evidence, releases its waiting todo,
and fabricates no human answer. CI does not substitute for bot approval or block
that policy’s approval check; this is not authorization to merge.

Push a new head: its card stays open until a review on that head approves it.
Under ci_only, pending/failed required checks remain unmet and positive green
required-check evidence passes without consulting reviews. Under human, even
all-green facts never retire a card automatically. A failed review read or a
push during collection stays open; a later successful current-head read retires.
The head and saved policy are confirmed again before returning success.

Keep observed.json, receipts.json, requests.jsonl, proof.log and wrapper exit
status. Focused contracts cover latest review supersession (including dismissal),
case/REST bot login aliases, multiple pages, malformed URLs/facts, policy changes
during collection, and absent policy. Existing pr_merged, question-retirement and
review/gate contracts must still pass. The helper closes its WebSocket and daemon
in finally and the wrapper removes temporary data immediately. This is operation
and native metadata-reader proof; browser layout, real GitHub and deployment
remain unverified. PR approval is a fact check, not the manual merge/QA gate.

The focused compatibility run must include neo-packs.test.ts: its enabled-pack
catalog expectation covers the coding description and guidance visible to Neo.
After the shared resource check, run from packages/daemon:

```sh
bunx vitest run --config vitest.config.ts tests/unit/1-core/operations/{coding-pr-approved,neo-packs,neo-coding-todo-prs,neo-coding-todo-policy,neo-coding-review,neo-coding-merge-gates,neo-question-retire-when,neo-check-only-reminders}.test.ts
```
