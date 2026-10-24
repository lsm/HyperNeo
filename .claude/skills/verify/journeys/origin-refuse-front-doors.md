## A cross-site page cannot use the daemon's WebSocket or mutate over HTTP (#7975)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/origin-refuse.sh 9341
```

The script regenerates the gitignored embedded-asset modules, then boots each front
door in turn (`daemon` = standalone daemon app, `prod` = prod-server, `dev` =
dev-server with Vite, `embedded` = prod-server-embedded) through
`origin-refuse-door.ts`: `env -i`, NODE_ENV=test, its own HOME, data dir and database,
no provider key. Pass door names after the port to run a subset. `origin-refuse-probe.ts`
opens WebSockets and POSTs `/pair` with synthetic Origin and Host headers, and allows
`web.example.ts.net` over `settings.global.update` halfway through.

End state, the same for every door:
- WebSocket from `https://evil.example`, from Origin `null`, and from
  `https://web.example.ts.net` before it is allowed: `refused`.
- WebSocket same-origin (Host `mac.example.ts.net`, Origin `https://mac.example.ts.net`),
  from `http://localhost:5173`, with no Origin, and from `web.example.ts.net` after
  allowing it: `connected`.
- `POST /pair` from a foreign Origin: `403`; same-origin and no Origin: `400` (the
  synthetic empty body, not a refusal).
- `GET /` from a foreign Origin: `200`.

Browser check (optional): with a prod-door daemon from `origin-refuse-door.ts`, open
`http://127.0.0.1:<port>/` in Chrome; the Spaces page loads over its same-origin
WebSocket. Chrome's local-network-access gate holds a WebSocket from a public page to
127.0.0.1 before it reaches the daemon, so the cross-site case is proven by the script,
not the browser.
