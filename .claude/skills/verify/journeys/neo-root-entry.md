# Neo opens at the web root

Build the current web bundle with the resource check in SKILL.md, then run
the headless Chromium journey through the shared disposable-run wrapper.

```sh
bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/neo-root-entry.sh "$EVIDENCE"
```

EVIDENCE must be a fresh absolute persistent directory. The helper uses an
ephemeral free port, a fresh HOME and database, the refusing GitHub stub and
the source CLI's production HTTP server. It pairs an actual browser with a
synthetic code from the isolated CLI, then follows Open HyperNeo.

Observe Neo at `/` and `/neo`, retaining query strings and fragments. Observe
the legacy app at `/sessions`, its session deep link and Settings Devices.
The browser cookie must be HttpOnly and SameSite Strict, and the consumed
pairing fragment must disappear. Codes stay out of screenshots and logs.

The helper saves route results and screenshots, closes Chromium, stops and
waits for its daemon, then lets with-run.sh remove its temporary data. Retain
the before failure where `/` opens the legacy app and becomes `/sessions`.
The shared resolver unit tests cover all three servers' entry decision. Run
the legacy router tests too, including its home navigation to `/sessions`.
The same run starts the standalone web package server and checks its root and
Neo HTML entries, legacy fallback and canonical redirect with query parameters.
