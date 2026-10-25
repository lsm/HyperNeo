# Neo messages retain an exact Preview context

Run the native RPC proof from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-preview-context-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun packages/daemon/tests/helpers/neo-preview-context-proof.ts "$RUN"
```

The helper seeds only synthetic files and SQLite through the existing preview
fixture helper, owns an ephemeral daemon and WebSocket client, and stops both in
finally. No provider turn, HTTP model mock, credential, GUI or live daemon is used.

Require `evidence/preview-context.json` to report `passed` and
`ownedResourcesStopped`. A registered artifact ID plus exact SHA-256 snapshot is
recorded on the accepted receipt, immutable human ask and SDK message. Both public
conversation readers expose the same path-free reference. A mismatched hash is
refused. Changing ownership makes the reference unavailable and reopening it
fails through the existing artifact read operation. Retrying the accepted request
before and after a daemon restart retains one message/job and the original
context; removing context conflicts. Older unbound messages still work.

The initial bound send and post-restart retry use the actual web
`submitNeoDraft` pipeline. Public ask responses pass through the web's
`presentConversationAskPage` before their exact context is asserted. Require
`webClientContext` and `webProjectionContext` in the evidence too. This proves the
client-to-daemon contract without a mock transport or a rendered binding control.

The voice proof uses the actual recording snapshot, durable send and receipt
functions with synthetic audio/transcript dependencies and in-memory IndexedDB.
Require `voiceSnapshotPersisted`, `voiceRetryAfterRestart`, `voiceRefusalRetained`
and `voiceMessageNoDuplicate`. A revoked snapshot retains its bound recording and
refusal rather than falling back to unbound text. The accepted voice request has
one SDK message/job after retry across daemon restart. This does not exercise a
microphone, real ASR or browser/device persistence; no default daemon is contacted.

Keep the evidence before deleting the fresh run directory. The focused operation
suite also checks strict input rejection and immutable retry conflicts. Run web
tests and build for shared-type compatibility. Composer binding and rendered
clickable references belong to the subsequent frontend slice; no GUI claim is made.

Also run the compiled-worker-startup journey when changing these schema import
boundaries. Source-mode RPC can pass while a schema-to-runtime dependency cycle
causes Bun to emit invalid compiled initializers. Require the actual compiled
binary to start and answer `system.build`, using the pinned release runtime.
