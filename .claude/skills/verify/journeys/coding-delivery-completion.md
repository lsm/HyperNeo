# Gated coding todos finish only after QA smoke

Use shared isolation in `../SKILL.md`. This backend journey needs no provider,
model, HTTP mock or browser. It owns two actual isolated daemon instances and
calls the normal operation door for `neo.coding.result`, `neo.coding.smoke` and
`neo.todo.close`.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-delivery-completion-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-delivery-completion.ts "$RUN"
```

The helper seeds only its synthetic todo and persisted review/QA assignments,
uses the existing merge-preparation API to record its receipt, and simulates a
merge in the refusing GitHub stub. The stub permits only PR views and synthetic
ancestry comparisons; no real GitHub mutation, merge command, deployment or restart
of the human's app occurs. Deployment evidence goes through the normal
`readGithubDeploys` composition, observing this isolated daemon's build commit.
External direct HTTP throws.

Pass: real `neo.todo.close` refuses merge-only and failed smoke, and still refuses
after app restart. The wrong actor cannot record smoke. A passing smoke from the
assigned QA actor then permits completion. `evidence/observed.json` retains every
operation reply, final todo and persisted receipt and ends with `verified: true`;
`evidence/gh.log` shows the actual stub calls. Both app instances and sockets
close in finally. Keep evidence outside the worktree.

Unit contracts also preserve unmarked `pr_merged`/`issue_closed` completion,
require CLOSED/COMPLETED for marked issues, accept recorded inapplicability only
with a reason, keep failed smoke pending, prevent a new head from restoring legacy
completion, reject invalidated QA and replay captured judgement after DB close.
The opt-in is sticky assignment `newDispatch` evidence across all heads; existing
unmarked todos and historical outcomes are not rewritten.

This slice wires completion and smoke only. Final merge-operation admission and
new-dispatch guidance still depend on c1 and the configured-bot review API; they
must land before #8429 closes. Live GitHub, real rollout and GUI behavior are not
verified by this synthetic backend journey.
