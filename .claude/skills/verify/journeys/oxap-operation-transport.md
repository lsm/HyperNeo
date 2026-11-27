# Loopback operations MCP

Use the shared isolation and pinned Bun in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-operation-transport.ts
```

The proof starts an isolated daemon and attaches an MCP client to each of two
chat grants. It compares the HTTP and Claude SDK tool catalogs, discovery
results and audited operation refusal. Catalog parity covers ordinary chats,
Neo, and the desktop tool profile. It checks that swapping bearers is
refused, and exercises the Origin, Host, media type and body size checks.

An MCP detach leaves its chat grant usable. Archiving and deleting the chat
each make the old bearer return 401 for an operation read. Unarchiving needs
a new grant. Daemon shutdown closes the listener. Check the wrapper exit code
and the counts in `operations-transport.json`.

## Released Codex attachment

Run the released macOS or Linux archive with its published checksum manifest
and Codex CLI 0.171.0. Use a fresh evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-codex-operations.ts /absolute/SHA256SUMS.txt \
  /absolute/oxap-0.1.0-alpha.47-macos-arm64.tar.gz /absolute/codex
```

This runs native Codex against an isolated loopback Responses fixture. The
daemon authenticates its disposable local RPC client, installs the unchanged
release archive, and sends turns to Codex through the released stdio hub.
The proof checks operations discovery, delivery by `message.send`, and the
ordinary-chat desktop refusal. A second released hub refuses a capability
issued to another chat and refuses its replay after use. The proof swaps
bearers between the two native chat grants and checks revocation after archive
and delete. Unarchive
reopens the same native thread with a fresh grant. A legacy thread opened
without source IDs resumes the same native thread without the MCP tool.
Check the wrapper exit status and `codex-operations.json`.
