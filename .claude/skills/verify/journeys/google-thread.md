# Read Gmail threads, with bodies and attachments only on request

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/google-thread.ts
```

Repeat with `VERIFY_PROOF_RUNTIME=deno` and pinned Deno on PATH. The shared wrapper
provides fresh test HOME/data/database and scrubs credentials. The helper starts
one isolated daemon and fake Google HTTP server on free loopback ports. Synthetic
account grants are fixtures; no real accounts, keys, model or external service.

Inspect `google-thread.json`. The real default operation registry/MCP adapter
must return metadata by default, with no body or attachment request. Explicit
flags enable text (including declared Latin-1) and small binary attachments.
Account/revision-bound cursors page without skipping messages, refuse another
account before I/O and refuse a changed thread. Scope/session refusal happens
before API access. Attachment failures retain their bounded failure reason.

Limits are visible: ten messages per page, 32 MIME parts per message, 4,096 text
characters per message (externally stored text parts are fetched up to 48,000 bytes), two attachments of at most 8 KiB each, and 64 KiB per
result. Oversized attachments are omitted; clipped bodies, excess parts/files and
remaining pages set `truncated`. A page that hits its byte budget resumes at the
first unreturned message. A single projected message that cannot fit returns
`response_limit`. Oversized upstream JSON is refused by the shared HTTP reader.
All content is marked untrusted. No mail send operation or write is involved.
Servers and daemon close in `finally`; the wrapper removes temporary data.
These proofs establish daemon/MCP behavior, not model tool selection or real
Google interoperability.

API references: [threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get),
[message parts](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages),
[attachments.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get).
