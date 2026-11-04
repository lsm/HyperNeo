# A work session opens as a preview tab on desktop

Use shared setup in ../SKILL.md. Build web first, then start the open-controls seed
(`neo-open-controls.ts`, see neo-open-controls.md) for a fresh synthetic run. Keep its
ready JSON. In a headless browser with Playwright and a Chromium executable:

```sh
NODE_PATH=<known-playwright-node_modules> VERIFY_BROWSER=<known-Chromium-executable> \
  node .claude/skills/verify/neo-session-tab-web.mjs "$READY" "$EVIDENCE"
```

At 1280px, opening a todo's Open for the synthetic "Local worker" must put the worker
chat in the preview tab strip: "Your work" first, the session tab selected, and no chat
inside the main column. Evidence: `session-tab.json` and `session-tab-desktop.png`.
The script stops the browser on exit. Phone widths keep the full-screen chat and are not
covered by this journey.
