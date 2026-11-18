# Outlook search and thread read through the operations MCP

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/outlook-mail.ts
```

Shared setup in SKILL.md supplies a fresh test HOME, data directory and database
with scrubbed credentials. The helper starts an isolated daemon and a fake Graph
server on loopback; any origin other than `https://graph.microsoft.com` is
refused before it reaches the fake. No real Microsoft account is used.

Synthetic grants seed one Microsoft and one Google connection. The daemon's
default operation registry and real MCP adapter run `microsoft.accounts`,
`outlook.search` and `outlook.read_thread`.

Check `outlook-mail.json`:

- Only the Microsoft account is listed.
- Search pages are bounded and redacted, with clipped previews. They page through an opaque cursor that never contains a Graph URL.
- A cursor for another query or operation is refused, and so is any cursor the daemon did not sign, including a hand-made one whose stored query would change the request path. Cursors only carry known Graph query options. A Google connection id is refused, and so is a caller without a session. None of these sends a Graph request.
- A next link on a foreign origin is refused, and a 429 maps to `rate_limited`.
- Thread reads select no body by default. With `body: true` they fetch each text body on its own; an 80 KiB body returns that message's preview marked truncated while the others keep their bodies.

No token, sensitive error text or Graph URL appears in any reply.
