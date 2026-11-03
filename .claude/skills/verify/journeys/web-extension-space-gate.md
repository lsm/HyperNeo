# Space shows only when the daemon lists it

The web asks `daemon.extensions` once connected and loads the Space chunk only
when the list includes `space` (or the daemon cannot answer). When the list
omits it, the shell hides Space: no Spaces tab or bottom tab, no Space commands,
and Space routes go to chats.

Dev daemons always list Space today, so the browser run rewrites the
`daemon.extensions` reply on the page's WebSocket to drop `space`. Isolated test
daemon only (NODE_ENV=test, own data dir, no keys, never 8399). Build web first:

```bash
cd packages/web && bun run build && cd ../..
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX") && rmdir "$RUN"
.claude/skills/verify/web-extension-space-gate.sh "$RUN" 9398
```

Checks: the daemon lists `space`; the unmodified page shows the Spaces home and
tab and loads the Space chunk; with `space` removed, `/spaces` lands on
`/sessions`, there is no Spaces tab at 1280 or 390 px (the desktop sidebar shows a plain Chats label instead of a one-slot switcher), ⌘K `>go to` lists sessions
but not spaces, no `space-web-extension`/`SpaceIsland` chunk is requested, and
no page errors. Evidence: `$RUN/evidence/web-extension-space-gate.json`,
`no-space-sidebar.png`, `no-space-desktop.png`, `no-space-phone.png`. Also rerun
`web-extension-space-surfaces.md` for the Space-on path.

The helper authenticates RPC and the browser with only the isolated daemon's
owner credential; no anonymous owner connection or live credential is used.
