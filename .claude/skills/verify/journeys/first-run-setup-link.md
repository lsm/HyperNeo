# First-run setup link (slice 1 of docs/design/first-run-setup.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
bash .claude/skills/verify/setup-link.sh 9471
```

The script starts an isolated CLI daemon (`env -i`, `NODE_ENV=test`, its own HOME,
data dir and database, no provider key), reads the setup link from the terminal the
daemon printed to, and redeems it with `POST /setup` the way a browser does (with an
Origin header). It restarts the daemon twice on the same database. Tokens, cookies
and credentials stay in shell variables and are never echoed; the run is removed on exit.

End state:
- A new daemon prints `Open http://127.0.0.1:<port>/setup#<token> to set up HyperNeo`;
  `<data-dir>/setup-token` is mode `600` and holds the same token.
- A WebSocket without a device answers `401`; a wrong token answers `401 invalid_token`.
- The printed token answers `200 human` with a device cookie; that cookie opens the
  WebSocket (`101`); one active owner exists.
- The same link again answers `409 has_owner`. The token appears nowhere in the daemon
  output except the printed line, and nowhere in the data dir except `setup-token`.
- After `hyperneo devices reset-human`, with no restart, the used link answers
  `401 invalid_token`: a token works only in the first-device window it was minted in.
- The restart after the reset prints a new link: the old token answers `401`, the new
  one grants once, then `409`. A restart with an owner prints no link.
- Each line prints `PASS` or `FAIL`; the script exits 1 if any expectation fails.

Windows file ACLs (`checkWindowsCredential`) are not covered here; this runs on POSIX only.
