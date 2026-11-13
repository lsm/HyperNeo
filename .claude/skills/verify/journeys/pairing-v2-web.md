## The web device page pairs a phone with a one-time QR (pairing v2)

Build the web bundle first (`cd packages/web && bun run build`), then run on two free
ports, the given one and the next (never 8399), on macOS (the script reads the QR with
Vision through `swift`):

```bash
.claude/skills/verify/pairing-v2-web.sh 8611
```

The script starts one isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key) with
`HYPERNEO_PAIRING_V2=on`, plus `tls-front.ts`, a local HTTPS front with a throwaway
self-signed certificate on the next port. A headless browser pairs with a CLI code, opens
Settings › Devices over plain http, then over HTTPS, and taps Start pairing. The
script plays the phone: it decodes the QR on screen, binds the ticket and completes over
the real `/pair2` endpoints. The browser's own session stands in for the paired phone
that approves a later device.

End state:
- On the plain-http page Start pairing shows the typed code and no QR: the QR only
  carries an HTTPS origin the page itself was served from.
- The QR decodes to `hyperneo://pair2?v=2&t=…&a=https://127.0.0.1:<port+1>`; the page
  shows the address and `Expires in 90 s`, also at 390 px wide.
- After bind the QR is gone. The browser is already a paired device, so this is a later
  phone and the page says `Phone scanned. Waiting for an owner device.` (a first phone
  says `Waiting for confirmation.`; `pair2-route.test.ts` and `PairPhoneFlow.test.tsx`
  cover that case);
  after complete it says `Paired with Kitchen iPhone.`
- A Cancel sent after the phone completed answers 403 and the page still says
  `Paired with Late iPhone.`
- A Cancel that wins says `Pairing cancelled.` with `Show a new QR`; the dark-mode QR
  keeps its white quiet zone.
- In a zh-Hans browser the intro and QR steps are Chinese (`7-qr-zh-Hans.png`).
- With the switch off (no `/pair2` route) Start pairing keeps the typed-code flow;
  `PairPhoneFlow.test.tsx` covers that case.
