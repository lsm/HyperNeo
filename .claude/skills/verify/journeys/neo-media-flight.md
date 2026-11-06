# Photos and file cards fly on send

Follow SKILL.md shared runtime, browser dependency and resource guards. Build the
current web checkout and run from the repository root.

```bash
bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-media-flight-web.mjs
```

The shared launcher owns a fresh keyless NODE_ENV=test daemon, synthetic browser
pairing and random ports excluding 8399/8499. It retains evidence, stops its owned
servers and deletes temporary daemon data. Browser traffic stays on that origin.

The reference was re-checked against neo-ios #354 at head
50683f1292933acd62a1726a3d4fa672f141b041, still open when this slice began. Its
attachment-flight behavior matches the approved f803f7fd patch. Photos start at
40px composer thumbnails and grow with corner radius 8 to 12. Files start at the
whole composer chip and use the existing sent file-card content. Each category
keeps message order. A media-only message has no words bubble.

At 1280px and 390px, independently test fine and actual coarse-pointer contexts.
Assert the pointer media query and tap the visible send button for touch. Send a
photo alone, a file alone, and an interleaved photo/file/photo set with words and
a quote. Delay the actual send RPC by 250ms for a mid-flight replacement, then by
1000ms for acceptance after landing. Forward the daemon's real response.

Record source rectangles before clearing and each ghost/destination rectangle
after frame work. Require all expected media ghosts, category order, a hidden
row during flight, roughly 550ms travel, and final bounds within 5px of each
live target. After landing, require less than 3px movement in each target bound,
continued bottom pinning, and no dummy bubble for media alone. Include a 16×12 photo at 390px with a coarse pointer, measuring its actual image
bounds alongside its wrapper. Open the landed
photo or file reader to check restored interaction and exact file contents.
At 390px, also enable reduced motion and send mixed media alone. Require all
three visible targets, an absent words bubble, and zero flight overlays. Inspect
mid-flight/landed and reduced-motion screenshots and evidence.json, including
narrow touch.

Component regressions cover thumbnail versus whole-chip capture, interleaved
category order, retained payloads, media-only/mixed rendering, row replacement,
8-to-12 photo radius and cleanup. Rerun neo-send-flight.md after changing the
shared loop to retain words/quote and reduced-motion coverage. Rerun the approved
plan's original baseline driver and keep its screenshots beside this evidence.
