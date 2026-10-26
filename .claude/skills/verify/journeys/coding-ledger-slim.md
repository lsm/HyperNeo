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
CI reruns, merge conflicts caused by base changes, and review decisions must
appear through the snapshot RPC on the next five-minute sweep even when neither
the head nor REST updated_at changes. Open-head cache reuse lasts less than five
minutes; only empty repositories use the thirty-minute backoff.
Ledger snapshots must retain every PR and show the review/merge transitions
and the opening session's ownership. The final snapshot RPC must expose both
the approved and merged PRs.
The fixed reader must use at most twelve synthetic query points and read the idle
repo no more than four times. `slimming.json` and `requests.jsonl` record measurements.
The fixture models six points per full query and one per selective query; these
are synthetic, not measured GitHub quota. Real costs are measured separately by
`coding-ledger-live-cost.md`. Report this distinction with any before/after result.

The wrapper retains evidence and removes synthetic daemon data after cleanup.
