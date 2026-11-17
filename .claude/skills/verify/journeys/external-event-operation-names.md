# External event operation pipeline names

Run each helper on base and change with Bun 1.4.2 and a fresh absolute evidence directory:

```sh
HYPERNEO_SPACE=off TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE_SESSION" .claude/skills/verify/external-event-operation-names.ts
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE_RPC" .claude/skills/verify/external-event-operation-rpc.ts
```

Compare each `replies.json` exactly, with the synthetic session ID and creation time normalized. The session journey uses the operations MCP server to subscribe, list, read a missing event, list deliveries and unsubscribe. The RPC journey checks missing event and agent replies and unresolved subscription and delivery scopes. Both use isolated data without provider credentials.
