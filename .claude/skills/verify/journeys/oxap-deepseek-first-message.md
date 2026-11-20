# First message in an OXAP DeepSeek chat

Follow the shared isolation and pinned Bun in `../SKILL.md`. Download the
pinned OXAP release archive for the host, check it against the release's
`SHA256SUMS.txt`, extract `oxap`, and compute the extracted binary's SHA-256.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-deepseek-first-message.ts /absolute/oxap RELEASE-NAME SHA256
```

The proof selects OXAP DeepSeek in the isolated daemon through the settings
RPC, opens a new DeepSeek chat, and sends its first message. It runs the real
OXAP hub with a synthetic dsh SDK peer. The chat's live feed must deliver the
assistant reply, and the hub must report `deepseek://sessions/<session_id>`
with the same ID the daemon saved. The hub must also advertise
`session.model.switch` as emulated. No live DeepSeek or OpenCode Go endpoint
is used.
