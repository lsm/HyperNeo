# Coding operation pipeline names

Run the helper with Bun 1.4.2 on base and change, using a fresh absolute evidence directory each time:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-operation-names.ts
```

Compare `replies.json` exactly. The isolated daemon invokes six coding operations over RPC with missing records and refused targets. The helper uses no provider credentials or real GitHub access.
