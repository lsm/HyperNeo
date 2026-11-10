### Connections settings (phase 1.5)

Build the web for the current committed head. Then run the real settings page in
an isolated headless browser profile and a fresh test daemon:

```bash
cd packages/web && bun run build && cd ../..
NODE_PATH=/path/to/installed/playwright/node_modules \
VERIFY_BROWSER=/path/to/chromium \
bash .claude/skills/verify/proof-run.sh /absolute/evidence/google-settings \
  .claude/skills/verify/google-settings.ts
```

Shared setup scrubs HOME, database, credentials and external services. The helper
owns two daemon boots, a fake Google consent/token/JWKS endpoint and headless
Chromium. It never opens the human's browser profile or a real Google account.
The browser's requests are restricted to loopback ports other than 8399. Fake
consent still uses the real PKCE loopback exchange and signed OIDC validation.

At Settings > Connections: capture the empty view, enter synthetic desktop OAuth
client details, approve fake consent and observe the account, health and granted
Gmail/Calendar access. Capture pending, connected and mobile states. A wrong
identity on reconnect produces an error while preserving the existing account;
a correct reconnect reuses saved client details. Restart the daemon against its
own synthetic database and observe the persisted account. Reconnect, disconnect,
reload and confirm that the disabled account remains visible. Reconnect after
credential erasure asks for client configuration again. Capture the result.

While consent is pending, inject one temporary reader outage. The error appears
and clears on a successful poll without another action. Failed action notices
remain visible when ordinary reads succeed.

The helpers retain screenshots and visible-text observations; no tokens are
returned through the browser operations or written into browser storage.
All browsers, popups, HTTP/WS listeners, loopback callbacks and daemons close in
finally. Real Google interoperability and OS keychain accounts remain unverified.
