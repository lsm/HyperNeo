# Media readers retain their pointer target

Use SKILL.md shared setup, pinned runtime, browser dependencies and resource
guards. Build the current web checkout and run from its repository root.

```bash
bash .claude/skills/verify/neo-sent-photos.sh /absolute/evidence-directory \
  .claude/skills/verify/neo-media-reader-pointer-web.mjs
```

The shared launcher creates an isolated keyless NODE_ENV=test daemon, pairs a
synthetic browser and picks random ports excluding 8399/8499. It retains evidence,
stops its owned servers and removes temporary daemon data. Traffic stays on that
origin and no model is configured.

At 390px, send synthetic history, quote a message and send words with a photo and
file. Keep the empty composer focused. Open the file and photo readers with a
100ms held pointer click, recording pointer/focus events and reader bounds.
Require pointer-up to retain the same reader trigger and its pointer-down y
coordinate within 1px. Require the corresponding dialog and exact file text. Close it, focus the
reader by keyboard and activate it with Enter too. Retain reader.json and the
before/after/keyboard screenshots for both readers.

Before the fix, default pointer-down focus blurred the empty composer. Collapsing
it moved the card 96px before pointer-up, click reached the containing DIV, and
the dialog stayed closed. The shared media-reader area now retains focus through
pointer-down, letting the reader action and its dialog own subsequent focus.
The same proof runs before and after the media flight is layered on top.
