# Read Calendar and complete the Google phase-1 flow

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/google-phase1.ts
```

Repeat with `VERIFY_PROOF_RUNTIME=deno` and pinned Deno on PATH. Shared setup in
SKILL.md supplies fresh test HOME/data, scrubbed credentials and free loopback
ports. This helper starts two real isolated daemons with separate databases and
a shared fake keychain, plus one fake Google HTTP endpoint. It never calls Google.

Inspect `google-phase1.json`. Through human management RPC, complete consent and
the real PKCE/loopback/JWKS/OIDC checks. Through the default registry/MCP adapter,
discover the connected account, search mail, read a thread, create and update an
unsent draft, and list Calendar calendars/events. Check opaque Calendar pagination,
exclusive all-day ends, daylight-saving offsets and local times with IANA zones.
Event listing needs an increasing RFC3339 window of at most 31 days; pages contain
at most 25 entries, with bounded summaries/location and a 64 KiB result limit.
Calendar text is untrusted. Dates, offsets and zones must survive unchanged.

Advance the fake clock through proactive refresh, restart one daemon, and prove
the rotated grant is reused. Connect the same synthetic Google identity in the
other instance: local connection ids and vault entries must remain separate.
Disconnect the first instance; its access stops while the second still works.
Status and MCP output must contain no token or client secret. The only writes are
draft create/update; there is no send, Calendar write or raw HTTP tool. All daemon
refresh schedulers, database workers, WebSockets and fake servers close in finally.

Run the focused `google-calendar.test.ts` contracts for role/scope refusal, account
selection, argument/time/page bounds, truncation and sanitized provider failures.
For the actual Settings UI, reuse [the Connections journey](google-connections-settings.md).
The combined helper proves daemon/RPC/MCP control flow against synthetic endpoints,
not real Google interoperability, live deployment or a model's choice of tools.

References: [CalendarList pagination](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list),
[event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[event date/time representation](https://developers.google.com/workspace/calendar/api/v3/reference/events).
