# Coding PR ledger acquisition budget

Use shared isolation and `proof-run.sh` in `../SKILL.md`. This helper starts its
own daemon with an ephemeral port, synthetic database and a refusing GitHub CLI
fixture. No model, external network, credentials or live daemon is used.

```bash
TMPDIR=/absolute/writable/temp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence .claude/skills/verify/coding-ledger-slim.ts verify
```

Run the same helper with `baseline` before changing acquisition. Retain separate
evidence directories. Twelve five-minute sweeps cover twenty open PRs and an
empty repository, same-head review changes, pending CI, a new head and a merge.
Ledger snapshots must retain every PR and show the review/merge transitions
and the opening session's ownership. The final snapshot RPC must expose both
the approved and merged PRs.
The fixed reader must hydrate fewer than sixty PRs and read the idle repo no
more than four times. `slimming.json` and `requests.jsonl` record measurements.
Quota points are synthetic (one point per hydrated PR), not measured GitHub
quota. Report this distinction with any before/after result.

The wrapper retains evidence and removes synthetic daemon data after cleanup.
