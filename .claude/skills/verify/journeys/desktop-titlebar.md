# Desktop titlebar on top-level pages

Build web for the checked-out head. On macOS run the resource check first, then:

```sh
NODE_PATH=<Playwright modules> VERIFY_BROWSER=<headless Chromium> \
  bash .claude/skills/verify/desktop-titlebar.sh <absolute-evidence-directory> after
```

The helper launches an isolated test daemon and pairs a synthetic browser. It
opens Neo, chats, a session, spaces, settings and pairing in light and dark at
1280 by 900. It overlays simulated traffic lights at x=16, y=28 and records
screenshots and geometry. A synthetic session workspace path is masked in screenshots. Every page must leave a 52px inset and expose a drag
region in the empty titlebar. The screenshots are visual evidence only; an
attended check in the actual desktop app is still needed to verify window drag.
The `before` phase records the same screenshots and fails on the broken layout.
