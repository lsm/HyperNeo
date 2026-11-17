# First-run setup token (slice 1 of docs/design/first-run-setup.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
bash .claude/skills/verify/setup-link.sh 9471
```

The script starts an isolated CLI daemon (`env -i`, `NODE_ENV=test`, its own HOME,
data dir and database, no provider key), reads the token from `<data-dir>/setup-token`,
and redeems it with `POST /setup` the way a browser does (with an
Origin header). It restarts the daemon three times on the same database. Tokens, cookies
and credentials stay in shell variables and are never echoed; the run is removed on exit.

End state:
- A new daemon writes a 43-character token to `<data-dir>/setup-token`, mode `600`.
  The daemon prints no link yet: the web `/setup` page that consumes it is slice 2.
- A WebSocket without a device answers `401`; a wrong token answers `401 invalid_token`.
- The file token answers `200 human` with a device cookie; that cookie opens the
  WebSocket (`101`); one active owner exists.
- The grant deletes `setup-token`. The same token again answers `409 has_owner`. The token appears nowhere in the daemon
  output, and nowhere in the data dir except `setup-token`.
- After `hyperneo devices reset-human`, with no restart, the used link answers
  `401 invalid_token`: a token works only in the first-device window it was minted in.
- The restart after the reset writes a new token: the old one answers `401`, the new
  one grants once, then `409`. A restart with an owner mints no token and leaves no `setup-token` file.
- Each line prints `PASS` or `FAIL`; the script exits 1 if any expectation fails.

Windows file ACLs (`checkWindowsCredential`) are not covered here; this runs on POSIX only.
