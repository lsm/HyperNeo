### Connect Microsoft in Settings > Connections

Build the web for the current committed head, then run the real settings page in
an isolated headless browser profile and a fresh test daemon:

```bash
cd packages/web && bun run build && cd ../..
NODE_PATH=/path/to/installed/playwright/node_modules \
VERIFY_BROWSER=/path/to/chromium \
bash .claude/skills/verify/proof-run.sh /absolute/evidence/microsoft-settings \
  .claude/skills/verify/microsoft-settings.ts
```

Shared setup scrubs HOME, database, credentials and external services. The
daemon's identity requests go to an in-process fake Microsoft token and key-set
endpoint; the browser's request to the Microsoft authorize URL is answered by a
fake consent page inside the browser route, and every other browser request must
stay on loopback. Consent still drives the real PKCE loopback listener on
`localhost` and the daemon's signed ID-token checks. The browser context is paired
through the real `/pair` endpoint first; an unpaired browser is refused every
connection operation.

At Settings > Connections: capture the empty view with both Connect buttons, open
Connect Google, enter a synthetic client ID, then switch to Microsoft and confirm
its client ID is empty. Enter a synthetic Application (client) ID (no client secret
field is shown) and capture the form. Reload during sign-in and confirm the
Microsoft pending status remains visible. Capture the pending status and the fake
consent page, approve, and observe the account, Connected and the Outlook mail
and calendar access. Reconnect reuses the saved client ID without the form.
Capture the mobile width, type Google client details, then disconnect the
Microsoft account and confirm the Microsoft form is empty. Reload and confirm
the disabled account stays listed. Enter Google client details, reconnect the disconnected Microsoft
account and confirm its setup starts empty. Begin Google sign-in with popups
blocked, switch to Microsoft and confirm Google pending status and its Continue
link remain visible. Submit Microsoft setup and confirm its pending status and
Continue link replace the Google sign-in status.

Screenshots and visible text land in the evidence directory; no token or code
appears on the page. Real Microsoft consent and account interoperability remain
unverified.
