# Coding review/QA facts and provenance policy (Build)

Read shared isolated setup in `../SKILL.md`. No provider, HTTP mock, GitHub,
credentials or browser is needed. The helper starts the real daemon on its own
ephemeral loopback port and stops only its own resources.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-stage-facts-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-stage-facts.ts "$RUN"
```

The local ledger writer records review and QA with PR/head, actor, verdict,
acceptance reference and evidence IDs. Todo claims read those same facts after
restarting the real daemon. A ledger head change and then a todo PR head change
each clear both stages, and a late old-head result is refused. Older todo and
ledger reads cannot regress the stage head; conflicting timestamps fail closed
until a newer read establishes the head. A two-repository reconcile accepts the
second repository’s new head over a todo observation made during the first read. Older reads cannot erase newer facts; a pass cannot
erase a recorded failure at the same head. Alias/unknown model identities are
refused as independent reviewers. The public
`pack.preferences` RPC door shows unanswered provenance stays unsaved, accepts
a human no answer without saving anything (provenance stays on), then an explicit
provenance-only false proposal confirmed with yes, persisted through restart. Local policy defaults
on, requires author provenance and prefers another model/harness. No merge or
completion decisions use these facts yet. This proves the Build persistence API
and existing preference API, not actor assignment, GitHub review ingestion, a UI
question being asked by a model, or completion gates.

Retain `evidence/stage-facts.json`. Run the focused `neo-coding-stage-facts`
and existing `neo-coding-pr-ledger` tests for the policy matrix and unchanged
ledger states. The helper closes both daemon instances and sockets in finally.
