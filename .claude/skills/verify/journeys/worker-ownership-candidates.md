# Review inferred worker ownership

Run the isolated daemon proof with synthetic rows and no provider credentials:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-ownership-candidates.ts verify
```

The preview lists start and weak cases, excluding send, adopt, bind, released
and human-named sessions. Apply rejects empty lists, count mismatches and refs
outside the current candidates; it rechecks claims and live todo bindings, reports skipped refs and
marks only eligible start bindings. Repeating the request is refused because
its applied ref is no longer a candidate. The JSON evidence records the replies
and resulting rows.
