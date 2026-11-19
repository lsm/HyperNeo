# Voice host keys in web settings

Build the web bundle and use the shared isolation and resource rules. Set
`VERIFY_BROWSER` to an installed headless Chromium executable and `NODE_PATH`
to a Playwright installation, then run:

```bash
bash .claude/skills/verify/voice-host-settings.sh /absolute/fresh/evidence-directory
```

The helper launches an isolated daemon, seeds two synthetic voice hosts, and
pairs a synthetic browser. It checks host deduplication, password inputs, and
saving and removing a synthetic key, including the credential-row count and
success feedback. It
captures light and dark screenshots at desktop and phone widths before entering
the key. The saved key must never appear in a screenshot or on reload. The shell
owns and removes the daemon, mock, and disposable data; keep the evidence outside
that run. A headless screenshot is not a display capture.
