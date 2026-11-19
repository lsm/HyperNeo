# Neo conversation operation pipeline names

Run the helper with Bun 1.4.4 on base and change, using a fresh absolute evidence directory each time:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-conversation-operation-names.ts
```

Compare `replies.json` exactly. The isolated daemon exercises search and missing conversation, image, draft and message targets through RPC without provider credentials.
