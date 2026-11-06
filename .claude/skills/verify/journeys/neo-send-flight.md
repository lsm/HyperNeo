# Sent words and quote flight

Use SKILL.md shared setup, pinned runtime, browser dependencies and resource
guards. Build the current web checkout, then run from its repository root.

```bash
bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-send-flight-web.mjs
```

The shared launcher pairs a synthetic browser to a fresh keyless NODE_ENV=test
HTTP daemon on random ports excluding 8399/8499. It saves logs, stops its owned
servers and deletes temporary daemon data. The browser permits only that origin.
No model or live daemon is needed.

The driver seeds synthetic conversation history, quotes a long message, scrolls
up and sends words. At 1280px and 390px, independently test fine-pointer and real
hasTouch contexts, assert the actual coarse-pointer media query, and use the
visible send button's tap interaction for touch. Use a four-line reply in the delayed case and check the words’ final height
against their destination as well as the outer box. Delay the actual send RPC by
250ms for a mid-flight pending/durable swap, then by 1000ms for acceptance after
landing. Forward the real response without replacing it.

Sample ghost and destination boxes after each animation frame's layout work.
Require words and quote to travel together for roughly 550ms, the composer quote
to disappear, and the destination row to stay hidden during flight. The last
visible ghost must match its target within 5px. After landing, require bottom
pinning, less than 3px bubble movement across delayed acceptance, and no repeated
arrival fade on the durable row. Keep per-frame evidence.json and mid-flight and
landed screenshots for every case, and inspect wide and narrow touch screenshots.

Run the approved plan's original baseline driver separately for plain words,
quoted words, photos, files and sending while scrolled up. Unit/component
regressions cover the pure phone path/easing, source rectangle capture, payload
preservation, failed-send quote restoration, row replacement, frame cancellation,
missing-target timeout and reduced-motion bypass. Photos/files flight and voice
flight are outside this slice. Headless touch evidence covers web media queries,
not an installed phone app.
