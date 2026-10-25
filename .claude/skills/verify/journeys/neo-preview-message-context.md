# Neo messages retain an exact Preview context

Run the native RPC proof from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-preview-context-XXXXXX)
mkdir -p "$RUN/home" "$RUN/tmp"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" TMPDIR="$RUN/tmp" TMP="$RUN/tmp" TEMP="$RUN/tmp" LOG_LEVEL=error \
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

Voice component/store regressions also require unsettled retries to preserve
quote/attachment framing, and unchanged sent text to clear after Preview removal
without clearing a newer draft/binding. Held bound recordings survive ordinary
24-hour expiry and capacity pruning until explicitly deleted or accepted. The
five-record durable limit still applies: full held capacity refuses new durable
admission, buffers fresh audio in the existing in-memory fallback, and prevents
sending until its settled intent can be durably stored.

Keep the evidence before deleting the fresh run directory. The focused operation
suite also checks strict input rejection and immutable retry conflicts. Run web
tests and build for shared-type compatibility. Composer binding and clickable references are covered by real `NeoLive`,
`NeoComposer`, `NeoVoice` and conversation component tests under happy-dom.
Require draft/file switching, explicit rebind/removal, attachment-only framing,
text clearing with retained attachments/in-flight reads/quotes, and fully empty reset,
phone dismissal, microphone-start capture, delayed metadata/send completion and
unavailable references. Available references reopen the canonical artifact ID;
the existing artifact reader authorizes it again. Work/file switching must keep
the viewer and avoid rereading file bytes even when binding metadata is fetched.
No unattended GUI/browser or real-device claim is made.

Mount-time Preview/draft readiness is scoped and reactive. Component/hook checks
cover metadata-before-draft ordering, an empty successful load, failed read and
reconnect, cancelled scopes, older request failure, and explicit removal/rebind or
new typing before completion. Only successful readiness may auto-bind an untouched
empty draft; a failed read is not empty. Reconnect reuses the existing adoption
refresh. Durable unsent context and immutable request recovery remain #8706/#8707
under #8675; readiness alone does not claim complete refresh recovery.

Also run the compiled-worker-startup journey when changing these schema import
boundaries. Source-mode RPC can pass while a schema-to-runtime dependency cycle
causes Bun to emit invalid compiled initializers. Require the actual compiled
binary to start and answer `system.build`, using the pinned release runtime.


Reload contract proof also requires `reloadContextContract`,
`explicitUnboundRecovery`, `alreadySavedContextRestore` and `legacyRecoveryDedup`.
The actual web reload buffer preserves a validated original reference or explicit
null; the owned RPC door refuses an exact submitted association, accepts a newly
unbound same-text draft and a draft already saved before reload, while legacy
requests without context retain text-only submitted detection. Malformed or
path-bearing stored references are refused without an unbound fallback.
Composer capture/recovery wiring remains #8721 and pending identity #8707; these
contract checks alone do not claim completed refresh recovery.


Reload capture checks also require `reloadSizeRefusalPreserved`: encoded text or
reference escaping that exceeds the existing serialized read budget must be
refused before storage writes, preserving the previous recoverable capture.
A subsequent valid edit must remain writable/readable/removable, and maximum raw
text/base plus bounded escaping and full context must still roundtrip. Read and
write share the same serialized-size limit; no larger read budget is introduced.


Require `reloadRecoveryProjection` too. The existing recovery hook and owned RPC
proof both use `neoDraftRecoveryInput` exported by the buffer module. It projects
a full stored reference to artifactId/snapshot, preserves explicit null and legacy
omission, and excludes displayName/state/capture id from the strict recovery
request. Component checks cover available/unavailable/null/legacy captures. This
transport projection does not implement later composer association restoration.


Send handoff checks also require `sendHandoffConditionalClear`,
`sendHandoffPreservesVoice` and `sendHandoffPreservesNewerDraft`. The real RPC
proof conditionally clears the previously recovered draft, preserves independent
staged dictation and refuses a stale clear over newer manual text. Resource-hook
and real-composer tests cover send refusal/storage cleanup failure, delayed
metadata, ordered recovery RPC completion, same-text rebinds during cleanup,
failed durable captures, reconnect and scope changes. Returning during pending
cleanup after editing another session must release adoption, while a failed
local edit remains guarded across the same round trip. Attachment-only and
text-with-attachment sends must release adoption after a superseded recovery or
failed browser write; the send's own attachment removal is not a human edit.
New text and attachments added during that handoff must survive its completion.
The original browser
capture remains until acceptance or explicit discard. Pending immutable request
identity persistence remains in #8707; handoff alone does not complete it.

Pending intake quote checks additionally require `intakeQuoteSnapshotRetry` and
`intakeDisplaySnapshotIsolation`. The actual intake client sends a synthetic
quoted, bound reply through the owned RPC door, then loses its accepted receipt.
Mutating the original nested target and pending display target/snapshot must not
change the retained retry: one message and delivery keep the original target and
exact Preview reference. Lifecycle tests also distinguish changed nested quote
targets from equal-value retries. This checks capture isolation; durable pending
request restoration remains a later #8707 rung.

The bounded versioned snapshot codec additionally requires `intakeSnapshotContract`
and `intakeSnapshotManualReplay`. Encode the actual pending intake projection
after the synthetic lost receipt, decode it and manually replay that exact request
through submitNeoDraft. Its original quote/Preview remains, created is false and
there is still one SDK message/job. Codec-only tests require no network or storage
effects; reject a corrupt batch as one typed refusal rather than an empty recovery.
Prepared thumbnail bytes, exact original timestamps/states and absent legacy
context roundtrip. This is the Build contract only; storage, map hydration and
application recovery activation remain subsequent #8707 children.

Require `intakeSnapshotInlineTextAttachments` and `intakeSnapshotLongQuote` too.
Read two valid text files through readNeoAttachment, compose them with the actual
attachmentMessage formatter and send the resulting body above100,000 characters
through the actual intake/RPC door. Quote that accepted ask with its full text.
Both pending records must roundtrip exactly and manually replay with created=false,
one SDK message/job each. Snapshot free-form text uses the existing16MiB aggregate
JSON budget; the100,000-character unsent editor bound must not reject already
composed attachment bodies or quoted ask text. No live send limit is changed.
