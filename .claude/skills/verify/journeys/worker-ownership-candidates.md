# Review inferred worker ownership

Run the isolated daemon proof with synthetic rows and no provider credentials:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-ownership-candidates.ts verify
```

The operation lists the start and weak claimed-only cases, excludes send, adopt, bind,
released and human-named cases, refuses application with or without a reviewed
list ID, and leaves all ownership rows unchanged. The JSON evidence records the
operation replies and the unchanged-row assertion.
