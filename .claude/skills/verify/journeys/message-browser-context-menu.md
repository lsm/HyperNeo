# Message bubbles preserve the browser context menu

Build web and launch an isolated run using shared setup. Open root with
`VERIFY_PORT=<port> bun .claude/skills/verify/rpc.ts neo.open '{}'`.
No provider or model turn is needed for this journey. If mock port 8000 is
busy, use the shared metadata-only daemon setup on a free port instead.

Run `NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<optional Chrome executable>
node .claude/skills/verify/message-context-menu-check.mjs <port> "$RUN" after`.
The helper seeds only the synthetic run DB, checks desktop right-click remains
uncancelled and opens no custom menu, then clicks the existing Reply button.
It checks short taps and touch movement do not open actions, while a long press
still offers Select text, Copy, Share and Reply. Sharing uses a stubbed Web Share
API; a real OS share sheet is not verified. Share has no desktop footer button;
mouse-only users lose that entry point, as disclosed in #9113.

Run the same helper with `before` against the baseline build to reproduce the
cancelled right-click and custom menu. Evidence JSON and screenshots are in
`$RUN/evidence/message-context-*`. Native browser chrome menus are outside DOM
screenshots; the browser default is verified by the uncancelled event, not by
pretending the custom menu's absence is a screenshot of a native menu.
For native visual confirmation, open the same isolated URL in headed Chrome,
right-click the message text, and capture its native menu (for example Copy Link
to Highlight, Print and Inspect) through the desktop accessibility/screenshot
surface.

End state: desktop Reply opens its composer quote, and touch Share receives the
whole message. Retain evidence, close browser and stop only the owned daemon.
