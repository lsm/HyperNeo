# Review inferred worker ownership

Run the isolated daemon proof with synthetic rows and no provider credentials:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-ownership-candidates.ts verify
```

The preview lists the start and weak claimed-only cases, and excludes send,
adopt, bind, released and human-named cases. Apply refuses missing or mismatched
reviewed-list IDs, changes only the reviewed unclaimed start binding, and does
nothing on repetition. The JSON evidence records the replies and resulting rows.
The reviewed list ID is the SHA-256 digest of the JSON array of `[adapter, id]`
pairs sorted by the pair's JSON representation. The ID binds the request to the
supplied list; review and approval remain external to this operation.
