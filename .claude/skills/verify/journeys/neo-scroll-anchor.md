## Neo scroll anchor (headless)

Build web. Launch on a free non-8399 port with a fresh synthetic run directory.
In that same shell (with a stop.sh EXIT trap), run:

```bash
NODE_PATH=<directory containing playwright> node .claude/skills/verify/neo-scroll-anchor-check.mjs 9379 "$RUN" verify
```

If Playwright's matching browser is unavailable, set `VERIFY_BROWSER` to an installed
Chromium executable. This always launches headlessly, never the desktop browser.
The helper validates the isolated daemon log, opens Neo over RPC, seeds 30 synthetic
publications in that DB, and drives the real built `/neo` page. It scrolls the
conversation up from the bottom, pins an anchor message near the top of the
viewport, and records the anchor's viewport offset on every animation frame while
injecting synthetic `neo.changed` events (refresh-only bursts), real appended
publications (bottom growth), and a real in-place edit above the anchor (height
change). While scrolled up, the anchor must not move more than 2 px in any frame.
It then scrolls to the bottom, appends one more publication, and asserts the view
kept following (within 160 px of the bottom).
Capture `evidence/neo-scroll-anchor-{before,after}.png` around the burst.
Evidence: `evidence/neo-scroll-anchor-<mode>.json` with per-burst maximum anchor
movement in pixels. `reproduce` mode asserts the regression exists (some burst
moves the anchor over 2 px); `verify` mode asserts all bursts hold the anchor and
the bottom still follows. This proves web behavior under synthetic events; it does
not verify iOS or native apps. If browser launch is blocked, retain the launch
error and report browser proof as pending.
