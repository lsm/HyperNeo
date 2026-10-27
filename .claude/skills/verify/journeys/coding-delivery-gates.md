# Coding delivery evidence storage

Use the shared isolation and resource guard in SKILL.md. The current
[coding smoke admission journey](coding-smoke-admission-db.md) exercises this
storage contract through the real public operation and its DB writer:

```sh
python3 .claude/skills/verify/coding-smoke-admission-db-run.py bun verify
python3 .claude/skills/verify/coding-smoke-admission-db-run.py deno verify --executable "$DENO"
```

The runner owns a fresh HOME/data/TMPDIR and ephemeral daemon, saves evidence,
and removes temporary data. It supplies a refusing GitHub fixture for synthetic
merged-PR reads and ancestry comparisons; direct external HTTP throws. No keys,
model, browser, live database or actual deployment are involved.

Assigned independent QA smoke requires the matching merge receipt, merged head
and containing build. Passing, failing and explicitly inapplicable records keep
full Unicode evidence. Failure survives reopening and a later valid record can
update it. The focused delivery contracts also retain full WorkRef independence,
historical head receipts and zero-row update refusal.

The receipt snapshot, independence checks and update now execute in one writer
transaction. The current helper pauses before dispatch and removes the queued
request's receipt, verifying matching_merge_gate_required without recording
smoke. Revoking the assignment also refuses and preserves prior evidence. The
older helper's interception between snapshot and write no longer represents this
atomic command boundary, so use the current helper above.

Evidence lives under evidence/coding-smoke-admission-db. The regression commit
71b407faf5 characterized the original wrong-head storage bug. Merge preparation
and declared todo completion have their own journeys; this verifies persisted
smoke admission rather than an actual rollout or rendered UI.
