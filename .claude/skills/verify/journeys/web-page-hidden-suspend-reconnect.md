# A web client suspended while hidden reconnects when shown, even offline

The web client closes its own socket with code 1000 (`Page hidden`) after a tab
stays hidden for 20 seconds, and must resume when the page is shown again.
Showing it while the browser reports `navigator.onLine` false must still resume:
the reconnect backoff handles an unreachable daemon, and the periodic state
check resumes a suspended transport on a visible page as a safety net. Before
the fix, a single offline reading at the moment of showing stranded the page in
`disconnected` forever while the banner kept claiming a retry was running.

This proof drives the real `ConnectionManager` and `WebSocketClientTransport`
from `packages/web/src/lib` against a real isolated daemon, with real
WebSockets and real timers. No browser is required, so it also runs where a
headless browser is blocked; it does not cover browser rendering of the
connection banner — the unit suites of `ConnectionOverlay` cover that text.

Use a fresh empty run directory and a free port other than 8399:

```bash
RUN=$(mktemp -d /private/tmp/hn-suspend-resume-XXXXXX)
bun .claude/skills/verify/web-suspend-resume-proof.ts "$RUN" 9311 fixed
```

Shared isolation rules from SKILL.md apply: the helper starts its own daemon
under `env -i` with `NODE_ENV=test`, a fresh `HOME`, its own data directory and
`--db-path`, and stops and waits for it in `finally`. It needs no provider,
model mock or GitHub stub. The client connects to `ws://0.0.0.0:<port>` so the
reachability check sees a non-loopback host while the connection stays local.

Expected timeline in `evidence/fixed-timeline.json`: first socket opens, closes
with code 1000 about 20 s after the page is hidden, and a second socket opens
within seconds of the page being shown while `navigator.onLine` is false, with
lifecycle states `disconnected → connecting → connected`. The module-level
`connectionManager` singleton also reacts to the synthetic events and logs
failed connects to its default URL; those attempts are unrelated noise.

For the failing baseline, check out the parent commit and rerun unchanged: the
helper exits 2 with `no_reconnect_within_70s` and no second socket, matching
the production incident where a client disconnected at 14:28Z never returned.
Exit 0 means the client reconnected; keep both timelines as evidence.
