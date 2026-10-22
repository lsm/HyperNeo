# An open web tab refreshes after deployment

The production bundle embeds its commit at build time, using the same release
SHA (or source Git HEAD) as the daemon. On every connected event, the shared
connection manager calls the existing read-only `system.build` operation. Two
known, different SHA values reload the current URL. A matching or unavailable
commit leaves the page open; failed discovery is retried at the next connection.
Vite development serving does not embed a commit or trigger deployment reloads.
This applies to standalone `/neo` as well as the main application.

Use a fresh empty directory and run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-web-build-reconnect-XXXXXX)
NODE_PATH=<directory-containing-playwright> \
  VERIFY_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node .claude/skills/verify/web-build-reconnect.mjs "$RUN" 9394
```

Shared isolation rules in SKILL.md apply. The helper constructs a clean child
environment with only PATH, its own HOME, NODE_ENV=test, its own data directory
and synthetic HYPERNEO_BUILD_COMMIT; its DB is inside that directory. It needs no
provider or model mock. It preflights the chosen port, refuses 8399, starts only
its own daemons and stops/waits for each child in finally. Never point this at a
live daemon. Builds change only the worktree's ignored web/dist output.

Headless Chrome keeps a real `/neo` tab open while the helper builds and starts
synthetic build A, restarts A, then builds/starts B and restarts B. Browser
sessionStorage counts document loads; navigation timing must report `reload`
after the change. Actual WebSocket `system.build` reads prove the connected
build and PID. Expected counts: 1 initially, 1 after reconnecting to A, 2 after
deploying B, and 2 after reconnecting to B. The pathname, query and hash stay
unchanged. Check `evidence/reconnect.json` and inspect before/after screenshots.
No provider request or publication-schema change is required for this proof.

For the failing baseline, the same helper with a third argument `reproduce`
asserts that the tab reconnects to B but remains at load count 1. The committed
ConnectionManager regression must fail before the fix and pass afterwards.

This cannot retrofit reload logic into JavaScript loaded before this fix:
those existing tabs need one manual refresh to receive it. Real deployments,
old publication decoding and unsent-draft recovery are not exercised here.
After an approved merge, report the deployed runtime build with `hyperneo build`
when deployment is available; this journey never deploys or restarts it.
