# API release compatibility

Use SKILL.md's metadata-only resource guard and proof wrapper. This is a CLI
surface; no browser, model, simulator or production daemon is needed. Fetch the
two trusted release tags first. Historical collection runs each tag's source in
a detached checkout with reused dependencies and a synthetic HOME/database; the
same generator is used for both. No installs or external requests are permitted.

```sh
bun run test:api-diff
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/api-diff.ts \
  --previous v0.52.0 --current v0.53.0 --worktree-root "$HISTORICAL_WORKTREES"
```

Set HISTORICAL_WORKTREES to a writable parent for temporary worktrees. On a host
with a required worktree location, use that location. The helper requires a known
changed pair and an existing committed snapshot at HEAD. It drives the actual
CLI, checks exact source commits, repeats historical collection with a different
phone inventory and requires stable snapshot hashes. It also checks same-ref
and working-snapshot modes, refuses an unknown ref, confirms the current snapshot
is unchanged and requires all historical worktrees to be removed. Run only one
heavy job at a time; the wrapper removes proof data after retaining evidence.

Review the actual tagged report against source for representative changes:
v0.52.0 to v0.53.0 removes both `work` and `consultation` publication input link
kinds rather than renaming them; the newer schema accepts only `project`. The
phone-used publication reader gains result session fields. Do not fabricate
risky changes to obtain a nonzero count; classifier tests exercise risky enum/
union growth, optionality, nullability and changed referenced alternatives.

Regenerate the default inventory with `api:phone-methods` using its configured
source checkout and pinned released commit, and compare it with the committed
file. Never use a dirty working tree or current main as released-phone evidence.
The report records payload-schema coverage for each source ref; refs without
the event-contract module must stay at zero typed payloads, even when the current
checkout owns schemas. Never interpret newly recorded coverage as historical
compatibility.

The default 0.5.0 (6) source association is owner-reported timing, without a retained
upload receipt. Keep that caveat in the report. The simple literal-call scan does
not infer computed method names; verify that all canonical operation-name
literals in the pinned product Swift source are covered. Legacy transport names
without operation schemas are not a validated API contract.

Retain api-diff.json, branch-release-report.md, proof.log and wrapper status.
After the daemon-owned merge, verify the merged containing build, obtain owner
deployment/build evidence and repeat the CLI from the deployed checkout. Only
then write the official report and requested persistent PR result document.
