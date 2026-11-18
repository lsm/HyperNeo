# Outlook calendar listing through the operations MCP

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/outlook-calendar.ts
```

Shared setup in SKILL.md supplies a fresh test HOME, data directory and database
with scrubbed credentials. The helper starts an isolated daemon and a fake Graph
calendar on loopback; any origin other than `https://graph.microsoft.com` is
refused before it reaches the fake. No real Microsoft account is used.

Synthetic grants seed one Microsoft and one Google connection. The daemon's
default operation registry and real MCP adapter run `outlook.calendar_list`.

Check `outlook-calendar.json`:

- Calendars list with id, name and default flag only; owner data is dropped.
- Events in a window: an all-day event returns dates with an exclusive end; a
  timed event keeps Graph's UTC start and end and its own start and end zones,
  including one that starts and ends in different zones.
- The second page comes from an opaque cursor; its request keeps the caller's
  window, not one from Graph's next link.
- A cursor for another window, a Google connection id and a window over 31 days
  are refused with no Graph request.
- Every Graph request is a GET and none selects `body`.

No token, event body or Graph URL appears in any reply.
