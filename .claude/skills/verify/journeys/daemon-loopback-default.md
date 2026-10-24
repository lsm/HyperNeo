## The daemon accepts LAN connections only with an explicit host

This metadata-only journey needs Bun, Python 3, lsof and a non-loopback IPv4
address assigned to this machine. Build the web bundle, then run the real CLI
with its default host and with the existing explicit host flag:

```bash
cd packages/web && bun run build && cd ../..
python3 .claude/skills/verify/loopback-bind.py "$RUN" \
  --lan-address '<this machine LAN IPv4>' --port 9389
```

Use a fresh, nonexistent `$RUN` directory. Ports 9389 and 9390 must be free;
choose another consecutive pair when needed, never including 8399. Do not use
`launch.sh`: it explicitly sets a loopback host and would hide the default.

The helper launches `packages/cli/main.ts` with a clean environment,
`NODE_ENV=test`, and a separate HOME, data directory, workspace and synthetic
database per case. No providers, credentials, model turns or GUI are needed.
Both cases must serve HTTP 200 and accept a loopback TCP connection. Without
`--host` or `HOST`, lsof must show `127.0.0.1` and a TCP connection to the LAN
address must be refused. With `--host 0.0.0.0`, lsof must show a wildcard IPv4
listener and the LAN connection must succeed. It stops and waits for each
owned daemon, then confirms its port is free even if an assertion fails.

`observed.json`, per-case `observed.json`, `listener.txt` and `daemon.log` retain
the source commit, CLI arguments, listener, connection results and shutdown
receipts. Keep LAN addresses and other machine details out of public comments.
This is a local LAN-address test, not a second-machine firewall test or proof
that explicitly exposed peers are authenticated. Existing LAN clients such as
iOS and another daemon must use an explicit host setting after this change.
