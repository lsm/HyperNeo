## Remote daemon pairing in Settings

Build the web bundle, then launch two isolated daemons with separate fresh run
directories, free daemon ports and free mock ports, using `launch.sh` and the
cleanup trap from SKILL.md. Set `NODE_PATH` to Playwright and optionally
`VERIFY_BROWSER`, then run:

```bash
node .claude/skills/verify/remote-daemon-pairing-web.mjs <local-port> <remote-port> "$RUN"
```

Use `$RUN/local` and `$RUN/remote` for the two launch directories. The helper
pairs a synthetic browser, checks a wrong remote code is shown as refused, then
attaches with a valid remote code and checks the code is cleared. It saves the
refusal at both 1280 and 390 pixels under `$RUN/local/evidence/`.
