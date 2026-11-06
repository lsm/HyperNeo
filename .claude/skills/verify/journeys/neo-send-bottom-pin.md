# Bottom pin through delayed message rendering

Follow SKILL.md shared setup, pinned Bun/browser dependencies and resource guards.
Build the current checkout and run from the repository root.

```bash
bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-send-bottom-pin-web.mjs
```

The shared launcher owns a fresh keyless NODE_ENV=test daemon on random ports
excluding 8399/8499, pairs a synthetic browser, retains evidence, stops its servers
and deletes temporary daemon data. Browser requests stay on that origin. No model
or live daemon is involved.

Send four-line replies quoting a long synthetic history message while following
the bottom. Delay the actual send RPC by 250ms and 1000ms, forwarding the daemon's
real response. At both 1280px and 390px, independently use fine-pointer and
hasTouch contexts, assert the actual coarse-pointer media query, and tap the
visible send button for touch. Record pending/durable row sizes and distance from
the bottom after every animation frame. Require both real row states and less
than 3px distance after settling, including when nested Markdown first shrinks
then grows the durable row. The historical flight draft lost 262px with a fine
pointer and 153px with touch at 390px. The independent pre-fix dev reproduction
lost 362px in its first delayed multiline case.

Then scroll up in one window and send new content from a second paired window.
Require the first window's visible message anchor to stay within 2px and remain
away from bottom. Inspect pending/durable and manual-reading screenshots, the
per-frame evidence.json and manual-reading.json.

The component regression simulates automatic clamping during nested message
rendering and checks bottom recovery plus preservation of manual reading. This
prerequisite changes scroll observation only. The separate flight journey must
still prove the overlay's final landing after rebasing on this change.
