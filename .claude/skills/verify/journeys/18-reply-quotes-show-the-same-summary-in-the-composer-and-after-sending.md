18. **Reply quotes show the same summary in the composer and after sending.**
    After opening root and configuring the mock provider, run
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/quote-summary-check.mjs <port> "$RUN"`.
    If Playwright's browser is not installed, set `VERIFY_BROWSER` to a Chrome
    executable; it runs headless with a fresh browser context. The check seeds
    a publication in the isolated run DB with different short and detailed text,
    then replies through the visible footer button and the touch long-press menu, types
    and sends a reply, and waits for the durable message rather than its pending
    preview. End state: all four quote previews show only the short summary;
    `evidence/quote-summary.json` records the observed strings, with composer
    and sent-message screenshots for both paths. To retain before/after proof,
    pass an evidence name as the third argument. Keep the launch shell alive
    while driving the UI if your command executor stops background children
    when the launching command exits.
    Repeat with `VERIFY_QUOTE_LONG=1` to seed a 350-character summary: composer
    and durable quote must both show the stored 300-character excerpt plus an
    ellipsis. The daemon and web share this excerpt rule; detailed message text
    remains available through Details and Copy.
