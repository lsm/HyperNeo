## Credential admission replaces report-only upgrades

The old S2 report-only behavior is retired. Use
[WebSocket credential admission](ws-credential-admission.md) for current checks.
The daemon still records bounded unpaired diagnostics without credentials, but
an unpaired socket no longer opens. Origin/Host and proxy addresses are not
credentials. Browser pairing remains covered by web-pairing.md.
