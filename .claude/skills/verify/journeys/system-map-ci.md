# System map CI attestation

Use the branch's clean, committed head with pinned Bun and `jq`. Fetch the
target first, install locked dependencies and run from the repository root:

```bash
bash .claude/skills/verify/system-map-ci.sh "$RUN/evidence" origin/dev
```

The helper makes the prospective merge tree and runs the workflow's diff
and check commands with event-shaped input. It requires a failing annotation
for a missing body, a block and error without head or base SHAs, and a
successful check with the current block. It records
the collapsed reports in `missing.log` and `current.log`. If the diff has required
path entries, complete their reasons in a copy of `attestation.md` and pass its
path as the third argument. Use the body of the actual PR as that third
argument to prove the submitted attestation.

On GitHub, open the System map job for the PR's current head and check the
collapsed log shows its event base and head, both impact reports, the full map
and the replacement block. After a review-fix push that leaves the required
reads and paths unchanged, System map passes on the new head with the unedited
body. Body and label edits rerun System map independently
of the main CI jobs. On a PR missing required path entries, adding the
maintainer-controlled `revert` label waives the entries while read claims still
apply. Removing the label restores the path checks.
