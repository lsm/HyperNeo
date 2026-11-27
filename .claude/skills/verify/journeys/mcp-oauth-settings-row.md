# Connect a remote MCP OAuth server from its Settings row

Build packages/web for HEAD first (see **Launch** in ../SKILL.md), then:

```sh
NODE_PATH=<directory containing playwright> \
  .claude/skills/verify/mcp-oauth-settings.sh /absolute/evidence/mcp-oauth-settings
```

Leave loopback port 18347 free for the test preset. The helper owns a fresh
isolated daemon, starts the fake MCP OAuth server, creates one HTTP row at the
test preset URL and one at another URL, and pairs a headless browser. It opens
Settings → Capabilities → MCP Servers and drives the `oauth-fixture` row:

1. Never connected: `Disconnected` and `Connect`. The other HTTP row shows no
   OAuth controls, because no preset matches its URL. Rows at the Jira and
   Basecamp MCP URLs also show `Disconnected` and `Connect`. The Slack row also
   shows `Client ID` and a password `Client secret` field, and its `Connect`
   stays disabled until both are filled (`slack-row.png`). The proof clicks none
   of the vendor buttons, so nothing reaches a vendor.
2. Connect opens the fake consent in a new tab; the row turns `Connected`.
3. After a reload the row is still `Connected`.
4. The proof deletes the stored grant from the disposable DB. After a reload,
   the row shows `Reconnect needed`.
5. Reconnect through consent: `Connected` again.
6. Disconnect: `Disconnected`, no Disconnect button, still after reload, and no
   grant stored.
7. Reconnect, then delete the row through its Delete button: the row is gone
   and no grant is left.

Require exit 0 and `pass: true` in `mcp-oauth-settings.json`. Inspect the
numbered PNGs for each state. No vendor and no real account are used. The authorize URL and scopes of the
Jira, Basecamp and Slack presets, and Slack's client secret token exchange, are checked against the fake server in
`packages/daemon/tests/unit/1-core/credentials/mcp-oauth-presets.test.ts`.
