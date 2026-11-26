# First message in an OXAP DeepSeek chat

Follow the shared isolation and pinned Bun in `../SKILL.md`. Download the
pinned OXAP release archive for the host, check it against the release's
`SHA256SUMS.txt`, extract `oxap`, and compute the extracted binary's SHA-256.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-deepseek-first-message.ts /absolute/oxap RELEASE-NAME SHA256 MODE
```

Use a fresh evidence directory for each mode. With `first`, a Pro chat delivers
its first reply. With `flash`, the reply confirms Flash receives the first
turn. With `image`, the inline PNG reaches Flash with its original bytes and
MIME type. The daemon saves the native ID reported by the hub and refuses a
model change after the first turn.

Build the web bundle and set `VERIFY_BROWSER` and `NODE_PATH` as described in
`../SKILL.md` before running `flash-web` and `pro-web`. These modes verify
attach, paste, drop, and the locked model picker in the real chat composer.
The Flash run sends the pasted image. Each image attempt in Pro shows guidance
naming the model and suggesting Flash. Both modes capture the attachment menu
and the delivered reply.

With `sdk-default`, the fixture stores a disposable credential over RPC,
switches the provider back to Claude Code after the first turn and sends a
second turn in the same chat. The local dsh peer requires the saved key, and
the transcript confirms the reply arrived on the original native thread.

The fixture runs the published OXAP hub with a local dsh peer.

With `routed`, save `model_provider: opencode-go` over RPC and send the first
message without an official DeepSeek key. With `routed-with-key`, repeat with a
stored official key. Both modes give only the hub a synthetic OpenCode key and
require the local dsh peer to receive the translated endpoint and key, use the
daemon-owned home without a managed credential file, and deliver a chat reply.
The served document must contain the provider ID and no key values. These
modes exercise OXAP routing without contacting OpenCode Go.

With `routed-web`, use the browser setup above to save the setting in Providers,
reload to check the saved setting and official API key field, and select DeepSeek
V4 Pro in the new chat picker without an official key. The fixture then sends a
message through the authenticated RPC and checks the same routed reply.
