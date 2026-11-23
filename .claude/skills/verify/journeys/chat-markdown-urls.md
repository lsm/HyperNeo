# URL schemes in chat Markdown

Build web and launch an isolated daemon with the shared instructions in
SKILL.md. Set `VERIFY_PORT` and `HYPERNEO_DATA_DIR` to the isolated port and
data directory. Supply `NODE_PATH` for Playwright and `VERIFY_BROWSER` for
Chromium if needed. Run this in the shell that owns the daemon:

```bash
node .claude/skills/verify/chat-markdown-urls.mjs "$VERIFY_PORT" "$RUN"
```

The helper seeds a synthetic assistant message and reads it through the paired
browser. It checks the exact destinations of four allowed links. The labels
for refused links and images stay visible without an active destination.
Review `evidence/chat-markdown-urls.json` and `evidence/chat-markdown-urls.png`
in the run directory.

Desktop loads the daemon's web bundle in a WebView. To check its browser
engine on macOS, repeat in a fresh run with `webkit` as the last argument
and Playwright WebKit installed. Leave `VERIFY_BROWSER` unset for WebKit.
