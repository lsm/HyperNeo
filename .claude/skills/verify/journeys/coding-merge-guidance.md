# Review and CI notifications do not bypass merge gates

Use shared isolation in `../SKILL.md`. No provider, model, HTTP mock or browser
is needed. The helper owns an actual isolated daemon and ephemeral port, writes
only its synthetic PR ledger, and runs the production PR event/sweep delivery
paths with a captured outgoing-message boundary.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-merge-guidance-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-merge-guidance.ts "$RUN"
```

Pass: `evidence/observed.json` retains the initial review/CI event, two reminders
and an escalation. Each requires all applicable merge gates; owner messages
require a fresh head and SHA pin rather than an unconditional merge instruction.
The production coding-worker goal formatter supplies the exact manual squash
command with `--match-head-commit`, a head reread immediately before merge, and
the existing ban on auto-merge. A merge does not replace a remaining recorded
smoke/deployment condition. The assembled root Neo pack briefing also names
merge admission and post-deploy smoke without retired coordinator routing terms
(the separately owned focused-discussion contract is excluded from that check).
The helper records that model-facing briefing and ends with `verified: true`, closes the app
in finally and forbids external direct HTTP. No merge or deployment is executed.
Keep the evidence outside the worktree.

The contract-first proof on the preceding commit fails on the old unconditional
merge message. This checks notification text and generated worker guidance, not
actual session transport, GitHub review acquisition, actor selection, final
admission activation or a live deployment. Use `coding-merge-admission.md` for
the final operation door, `coding-actor-assignments.md` for actor dispatch and
`coding-delivery-completion.md` for the deployment-smoke completion gate.
