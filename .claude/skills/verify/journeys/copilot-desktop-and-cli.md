# Copilot Desktop and CLI

Run each mode on a build or verification host with the pinned Bun and a fresh
absolute evidence directory. Select a free loopback port other than 8399.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/new-evidence \
  .claude/skills/verify/copilot-desktop.ts 9386 both
```

Repeat for `desktop` and `cli`. Each run starts the real daemon and invokes
its public operations. The standalone Desktop state and transcripts are
synthetic. The CLI uses the pinned SDK with the framed-protocol fixture.

A single Copilot adapter should appear in each mode. When both discovery
sources contain the same identity, the Desktop title, workspace link, and saved
status win. Verify Desktop history, exact input lookup, and settled turn facts.
The daemon must refuse sends to a Desktop-owned session and preserve the App
database. CLI start is available only when the CLI is present. Use the Copilot
owned lifecycle and input delivery journeys for CLI mutation proof.

Desktop exposes find, status, read, and turns through the driver. The public
launch link opens an App confirmation or draft and supplies no submitted-turn
receipt. Desktop mutations are unsupported, and an attended App run is still
required to verify a live session and its deep-link target.

The CLI also exposes start, send, queue, withdraw, stop, rename, and archive
for daemon-owned sessions. Strict same-turn steering and driver compaction
are unsupported.
