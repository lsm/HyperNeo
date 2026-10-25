## Settings > Devices guides pairing a phone: address, code, then the paired device by name

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/guided-pairing.sh 9323
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key). It drives
headless Chromium with `guided-pairing-view.mjs` (the downloaded Playwright
browser, falling back to the installed Google Chrome when there is none): a desk
browser pairs at `/pair#<code>` from `hyperneo pair`, opens
`/settings?tab=devices`, presses `Start pairing`, and reads the address and code
the flow shows. The "phone" is a plain `POST /pair` from the driver with that
code. Codes stay in variables and a mode-600 file outside `evidence/`; screenshots
that could show a live code mask it, and the script greps the daemon log for
every code.

End state, in `$RUN/evidence/`:

- `guided-pairing-waiting-1280.png`: the flow shows the daemon address
  (`http://127.0.0.1:<port>`), the same-Wi-Fi-or-Tailscale network hint, the
  masked pairing code and `Waiting for the phone to pair...` at desktop width.
- `guided-pairing-waiting-390.png`: the same waiting state at phone width.
- The phone's `POST /pair` answers 200 and the page shows
  `Paired: Kitchen iPhone` without a reload (`guided-pairing-paired-390.png`,
  `guided-pairing-paired-1280.png`; the device list shows `Kitchen iPhone`).
- `guided-pairing-waiting-dark-1280.png`: the waiting state again in dark mode,
  from a second context reusing the desk browser's credential cookie.
- `paired_devices` holds `Desk browser:human, Kitchen iPhone:human`; every
  pairing code appears 0 times in the daemon log.
