# Outlook drafts through the operations MCP

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/outlook-draft.ts
```

Shared setup in SKILL.md supplies a fresh test HOME, data directory and database
with scrubbed credentials. The helper starts an isolated daemon and a fake Graph
mailbox on loopback; any origin other than `https://graph.microsoft.com` is
refused before it reaches the fake. No real Microsoft account is used.

Synthetic grants seed one Microsoft and one Google connection. The daemon's
default operation registry and real MCP adapter run `outlook.draft`.

Check `outlook-draft.json`:

- A new draft is created in the fake mailbox and its id is returned.
- Updating that draft by id changes it in place and returns the same id.
- Updating a received message is refused as `not_a_draft` after one read; the
  message is unchanged.
- A Google connection id is refused with no Graph request.
- The fake records zero send, move, copy, reply, forward or delete requests.

No token or Graph URL appears in any reply.
