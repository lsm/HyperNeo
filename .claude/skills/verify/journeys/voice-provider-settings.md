# Voice provider settings

Build the web bundle and follow the shared isolation and resource rules. Set
`VERIFY_BROWSER` and `NODE_PATH` to an installed headless Chromium and Playwright,
then run `bash .claude/skills/verify/voice-provider-settings.sh <evidence-directory>`.

The journey seeds synthetic voice settings in an isolated daemon, edits providers
and speech fields in the web UI, reloads to verify persistence, and captures
light and dark desktop and phone screenshots. The shell removes the daemon and
disposable data. Headless screenshots are not display captures.
