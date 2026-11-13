## The web device page pairs a phone with a one-time QR (pairing v2)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free port
(never 8399), on macOS (the script reads the QR with Vision through `swift`):

```bash
.claude/skills/verify/pairing-v2-web.sh 8611
```

The script starts one isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key) with
`HYPERNEO_PAIRING_V2=on` and `allowedHosts` set to a made-up `.ts.net` name. A headless
browser pairs with a CLI code, opens Settings › Devices and taps Start pairing. The
script plays the phone: it decodes the QR on screen, binds the ticket and completes over
the real `/pair2` endpoints. The browser's own session stands in for the paired phone
that approves a later device.

End state:
- The QR decodes to `hyperneo://pair2?v=2&t=…&a=https://<allowed host>`; the page shows
  the address and `Expires in 90 s`.
- After bind the QR is gone and the page says `Phone scanned. Waiting for confirmation.`;
  after complete it says `Paired with Kitchen iPhone.`
- A Cancel sent after the phone completed answers 403 and the page still says
  `Paired with Late iPhone.`
- A Cancel that wins says `Pairing cancelled.` with `Show a new QR`; the dark-mode QR
  keeps its white quiet zone.
- With the switch off (no `/pair2` route) Start pairing keeps the typed-code flow;
  `PairPhoneFlow.test.tsx` covers that case.
