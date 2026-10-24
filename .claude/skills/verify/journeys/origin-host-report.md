## Origin and Host checks only record what they would refuse (S7 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/origin-host.sh 9321
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key). It sends a page
request with a foreign Host (DNS rebinding), one with a foreign Origin, a CORS preflight
from a foreign Origin, one to a tailnet name, and a WebSocket call with a foreign Origin.
Then headless Chromium (`origin-host-view.mjs`) pairs a browser, opens
`/settings?tab=devices`, and adds the tailnet name under Allowed hosts. The pairing code
stays in a shell variable.

End state:
- Every page request is still served (`200`), and the preflight still answers
  `Access-Control-Allow-Origin: *`. The foreign-Origin WebSocket prints `served: false`:
  cross-site upgrades are refused since #7975 (`origin-refuse-front-doors.md`), and the
  Host check stays observe-only.
- `would_refuse_requests` holds one row per reason, kind, host and origin: `host_not_allowed`
  for `rebind.example` and `mac.tailnet.example`, `origin_not_allowed` for
  `https://evil.example` as `http`, `preflight` (2: curl's two requests) and `ws`.
- "Would be refused" on the Devices page lists the same rows; `origin-host-1280.png` and
  `origin-host-390.png` show it with `mac.tailnet.example` under Allowed hosts.
- After adding the tailnet name, another request to it is served and its recorded count
  stays the same.
- The pairing code appears 0 times in the daemon log.
