# Phone attachment upload design

## Plain-language summary

- Photos start uploading as soon as you choose them.
- Each photo shows progress and can be retried or removed.
- You cannot send until every photo is ready.
- Each photo has its own size limit; the shared 8 MiB limit goes away.
- This is a design only, split into five small implementation PRs.

Date: 2026-11-25
Status: proposed; design only

## Recommendation

Upload each image as soon as its normalized bytes are staged in the phone draft. Use a paired binary HTTP request that exposes real byte progress. The upload returns a small, hash-checked reference; the existing send RPCs carry that reference instead of base64. The daemon resolves references back into the existing image blocks before persistence, so SDK, transcript, thumbnail, and image-read behavior stays unchanged.

Remove the phone's combined 8 MiB draft budget. Keep six attachments per message, 3.75 MiB per image, and 128 KiB per text file. Text files remain inline and become ready immediately; only images need the new upload channel.

Do not add chunking, resumable offsets, a new artifact system, a database table, a legacy base64 fallback, background upload infrastructure, or a web-composer rewrite.

## What happens today

- The phone composer caps a draft at six attachments and 8 MiB combined, counting base64 length for images and byte length for text. A single image is already normalized to 3.75 MiB; text is capped at 128 KiB.
- Three photos can each fit the per-file limit while their combined base64 size exceeds the draft limit. The composer rejects the third before Send, so the outgoing message contains only the first two.
- Draft bytes are saved on the device. The durable outbox reads those bytes and base64-encodes every image for every delivery attempt.
- Neo chats call `neo.message.send` with text plus base64 image blocks. Work chats call the legacy `message.send` RPC with an `images` array. The current Send predicate only checks for text or attachments.
- The daemon's Neo schema accepts only text and base64 image blocks (`packages/daemon/src/lib/neo/intake.ts:35-66`). The legacy work-chat handler accepts base64 images and checks each against the 5 MiB base64 limit (`packages/daemon/src/lib/rpc-handlers/session-handlers.ts:619-655`; `packages/daemon/src/lib/session/message-persistence.ts:35-47`). The 3.75 MiB raw-image cap produces at most exactly 5 MiB of base64.
- There is no general attachment upload endpoint. `packages/daemon/src/lib/rpc-handlers/message-image-route.ts:6-72` is GET-only and serves images already persisted on messages. Handoff and artifact references represent published/read-side files, not pending composer images; reusing them would add ownership and lifecycle semantics that this flow does not need.
- The web composer also has an 8 MiB combined check (`packages/web/src/neo/neo-attachments.ts:112-120,145-180`), but changing web behavior is outside this phone-focused design.

## External benchmark

Public documentation supports per-file limits and composer selection, but does not specify upload timing, progress, Send gating, removal, or retry behavior:

- Claude's [Upload files to Claude](https://support.claude.com/en/articles/8241126-what-kinds-of-documents-can-i-upload-to-claude-ai) documents `+` → `Add files or photos`, JPEG/PNG/GIF/WebP, 500 MB per chat file, and up to 20 files per chat.
- ChatGPT's [Image Inputs FAQ](https://help.openai.com/en/articles/8400551-chatgpt-file-uploads-faq) documents `+` → `Add photos & files` on iOS/Android, a 20 MB per-image limit, and resizing before analysis.

Therefore, immediate upload, per-chip progress/removal, and Send gating below are the requested Claude-style product requirements, not claims about undocumented internals of either app. Both products' documented per-file model supports removing Neo's combined draft budget.

## Daemon contract

### Binary upload

Add one authenticated route beside the existing paired image route:

```text
PUT /api/attachments/{attachmentUuid}
Authorization: Bearer <paired-device credential>
Content-Type: image/png | image/jpeg | image/gif | image/webp
X-Attachment-SHA256: <64 lowercase hex characters>
Content-Length: <1...3932160>

<raw image bytes>
```

A successful response is the reference used at send time:

```json
{
  "id": "attachment-uuid",
  "mediaType": "image/jpeg",
  "byteCount": 123456,
  "sha256": "64-lowercase-hex-characters"
}
```

Behavior:

- Reuse `authenticateUpgrade`, the paired daemon origin, and the request guards already wired in `packages/daemon/src/app.ts:1336-1366,1426-1468`. Do not accept a caller-supplied URL or follow a credentialed redirect.
- Stream the body to a temporary file under the daemon data directory. Reject an oversized declared length before reading and stop a streamed body at the same 3.75 MiB boundary. Never buffer the whole request merely to enforce the limit.
- Verify nonempty bytes, supported image signature, declared media type, byte count, and SHA-256. The full random UUID plus hash is the capability reference; there is no public read URL.
- Reserve a UUID before streaming. Matching concurrent PUTs share the first attempt's result, and conflicting metadata or hashes return `409`. Check for cancellation and atomically rename the verified temporary file under the same per-UUID coordination used for DELETE and expiry. Replaying a published upload with matching metadata returns the same reference. Other failures are `400` for malformed metadata, `401` for pairing, `413` for size, and `415` for media type.
- `DELETE /api/attachments/{attachmentUuid}` uses the same pairing check and is idempotent. It cancels any admitted PUT and removes any published file before returning. Keep the UUID reserved until the cancelled writer has cleaned up, so it cannot publish after DELETE. The phone cancels its local task before issuing best-effort DELETE. A later PUT can stage the same bytes again.
- Cap staging at 64 files daemon-wide (240 MiB at the per-file limit), including reservations for active writes. Return a retryable `503` when full. Release a reservation only after its file is removed or counted as published. Limit each PUT to two minutes and remove its temporary file on failure, timeout, or cancellation. Remove abandoned temporary files before serving requests after restart.
- Published files expire seven days after publication. Sweep at startup and hourly, and reclaim expired slots before refusing a new PUT for capacity. Treat expired references as missing on read. Removal, discard, and acknowledged delivery still issue best-effort DELETE for earlier cleanup.

Add a small messaging-owned store/resolver, not a new domain layer:

- `packages/daemon/src/lib/messaging/attachment-upload.ts`: reference schema, size/hash verification, atomic staging, read, and delete.
- `packages/daemon/src/lib/rpc-handlers/attachment-upload-route.ts`: paired PUT/DELETE adapter.

A staged upload contains only its bytes. Its file timestamp records publication time, and the reference carries its hash and media metadata.

### Sending references

Extend only the two phone-used intake contracts with optional `attachments: AttachmentRef[]`:

1. `neo.message.send`: keep the existing content schema for inline calls. Allow `content: []` and defer the mailbox projection only for this operation when at least one valid reference is present. Append the resolved images in attachment order after any inline blocks, then validate the nonempty content with `SessionContentSchema` and the mailbox projection before `neoIntakeMessage`, persistence, and `neoIntakeImages`. Thumbnail indexes refer to the final block list. After caller and target admission, use the stored prompt's corresponding image blocks for an existing `requestId` replay. Verify their length, hash, and media type against the references and retain the existing ask-conflict check. A matching replay returns the existing receipt even if staging has expired or been deleted.
2. Legacy work-chat `message.send` in `session-handlers.ts`: resolve `attachments`, append them to the existing `images` array, then call the existing `validateImageSizes` and persistence path. This is not the separate `message.send` operation envelope in `messaging/message-send.ts`; that operation does not need a new contract for this phone feature.

For either route, when `attachments` is present:

- Require at most six total image blocks across inline content/images and references, with no duplicate reference IDs.
- Read and verify each referenced file's length and hash before session persistence. Missing, changed, or invalid files produce a typed refusal; there is no automatic base64 resend fallback.
- Enforce each file independently. Do not introduce a daemon combined-size check.

The phone's final RPC is small even for six maximum-size images. The daemon still creates the same base64 message internally, and the existing per-image 5 MiB base64 validation remains the downstream guard.

## Phone state and behavior

Each image attachment has exactly one durable upload state. Progress itself is runtime-only; do not write every progress callback to disk.

| State | Meaning | Composer treatment |
| --- | --- | --- |
| `uploading` | Bytes are saved locally; upload is queued, waiting for connectivity, or in flight | Thumbnail, spinner or byte progress, Remove; Send disabled |
| `ready(reference)` | Daemon verified and stored these exact bytes | Thumbnail and size, Remove; Send allowed when every other attachment is also ready |
| `failed(reason)` | Last attempt failed or the local blob became invalid | Thumbnail if available, short error, Retry and Remove; Send disabled |

Text attachments use the existing inline representation and are immediately ready. The existing `unavailable` local-blob case remains a blocking condition rather than a fourth network state.

### Selection and removal

- After any existing HEIC/JPEG normalization, write the local draft blob and `.uploading` before starting the request. Start one upload per selected image immediately; six is the existing maximum.
- Upload tasks retain their originating daemon URL, credential, draft scope, UUID, and hash. Switching chats does not retarget an upload.
- Removing an uploading image cancels its task, deletes the local draft blob, and best-effort DELETEs the remote UUID because the request may already have completed. Removing a ready or failed image does the same local removal and remote cleanup when a reference exists.
- After acknowledgement, the outbox issues best-effort DELETE for its references and can release the local bytes.

### Retry, offline, and relaunch

- Selecting while offline leaves the chip in `uploading` with `Waiting for connection`; it is not a failure. Start the PUT on reconnection or foreground return.
- An active request that fails becomes `failed`. Retry reuses the same local bytes, UUID, and hash and repeats the whole PUT. There is no partial resume. A successful idempotent replay is indistinguishable from a first upload.
- On relaunch, restore `ready` and `failed` as saved. Restart saved `uploading` items with the same idempotent PUT. Local blob/hash validation still runs before every attempt.
- Keep the existing outbox distinction: Neo request IDs retry safely; an ambiguous work-chat send waits for the user's retry decision. Stored references avoid re-encoding on every attempt, while local bytes remain until acknowledgement/edit/discard for recovery.
- If the daemon reports a missing, expired, or changed reference, mark that attachment `failed`. Retry stages the saved bytes again with the same UUID and hash. If a changed file causes a UUID conflict, stage those bytes under a new upload UUID and replace the reference. Keep an affected outbox entry and its delivery state until recovery or discard.

### Upgrading saved drafts and outbox entries

- On draft restore, load existing attachments with their saved bytes and IDs. An image without an upload state becomes `uploading` and is saved before PUT. Inline text stays ready. Missing local bytes use the existing unavailable state. Reopening a partially migrated draft resumes from its saved states.
- Upgrade each legacy outbox entry in place before its next permitted delivery attempt. Stage its saved images, persist each ready reference, and preserve message content, order, destination, and request ID. Legacy Neo entries with an ambiguous result retry with the original request ID, so earlier acceptance still returns one receipt. An ambiguous work-chat entry stays paused until the user chooses Retry. Migration alone never re-enqueues it. Keep local bytes and leave recoverable entries queued if staging fails.

### Send gating

Use one shared enqueue predicate, not only a disabled SwiftUI button:

```text
has text or at least one attachment
AND no attachment is uploading
AND no attachment is failed or locally unavailable
AND every image has a ready reference
```

Apply it to root Neo, work chats, voice-transcript sends, and the recording arrow. A failed or unfinished attachment blocks the whole message until it uploads successfully or is removed. Stopping a recording to keep a draft remains available.

## Limits and related phone work

Keep:

- Six attachments per message.
- 3.75 MiB raw per image and the existing normalization for unsupported/larger images.
- 128 KiB UTF-8 text files, inline as fenced text.
- The daemon's independent 5 MiB base64-per-image validation.

Drop:

- The combined payload-byte admission and every phone merge/edit/restore check whose purpose is the 8 MiB total.
- Equal-slot compression. Do not compress a 3.46 MiB photo merely because six attachment slots exist.
- The old `Attachments are too large together` phone warning once no combined check remains.

Keep the visible, dismissible composer warning for count/local validation errors and upload-failure summaries. Preserve the renderer pixel-scale correction when downscaling so it uses pixel dimensions rather than device scale. Replace combined-budget UI fixtures when the new limit model lands; dismissal must never clear an attachment or bypass Send gating.

The web's combined budget is unchanged by these slices.

## Ordered PR slices

Each slice branches from the current default branch after its predecessor merges. Production-line figures are merge caps, not estimates; exceeding one means split Pin/Extract/Build/Wire work rather than widening the PR.

1. **HyperNeo: paired upload endpoint and staging store** — cap 200 production lines. Add only the PUT/DELETE route, store, resolver, and focused tests. No send caller. Prove streaming limits, signature/hash checks, pairing, capacity, expiry, and temporary-file cleanup. Race matching and conflicting PUTs and DELETE against an admitted PUT. Verify one publication, `409` for conflicting bytes, and no publication after DELETE.
2. **HyperNeo: Neo references** — cap 140 production lines. Add `attachments` to `neo.message.send` and validate resolved content before message construction/image recording. Prove a reference-only send, rejection of an empty request, replay after staging deletion, ordering, thumbnail indexes, per-file acceptance, seven-image count rejection, and no combined-byte rejection.
3. **HyperNeo: work-chat references** — cap 100 production lines. Add the same optional field to the legacy RPC, resolve before `validateImageSizes`, and leave generic operation/web callers untouched. Prove missing-reference refusal precedes persistence and existing base64 calls are unchanged.
4. **iOS: upload client and attachment states** — cap 200 production lines. Add credentialed PUT/DELETE with delegate progress and redirect refusal, reference coding, durable states, and chip rendering for uploading/ready/failed. Existing drafts retain their current representation until the wiring slice, so behavior does not change yet. Include the renderer pixel-scale correction.
5. **iOS: wire uploads and remove the combined budget** — cap 200 production lines. Wire selection, persistence, reconnection/relaunch, Retry/Remove, outbox references/cleanup, saved-draft and outbox upgrade, and the shared Send gate across typed and voice paths. Delete all phone combined-budget checks and replace the obsolete warning fixture. If shared store wiring exceeds the cap, split a test-only Pin PR first, not root versus work-chat gating.

Daemon slices 2 and 3 are independent after slice 1; iOS slice 5 requires both. No compatibility window is needed because old clients keep their existing base64 contracts and new clients require the merged daemon.

## Measurable final standard

The feature is complete only when the real app and daemon, on the merged heads, demonstrate all of these:

- With delayed uploads, each picked image appears in `uploading`, byte progress advances independently, and Send remains disabled until every image is ready.
- A forced failure keeps Send disabled. Retry succeeds with the same UUID/hash; Remove also restores a sendable state when no other blockers remain.
- Offline selection shows `Waiting for connection`; reconnect and app relaunch finish the saved uploads without reselection. Repeating PUT creates no second stored attachment.
- A saved draft whose remote upload has expired can send after re-uploading its local bytes. Upgrade restores an existing draft and delivers a queued send with its original content and attachments.
- Six of the existing 3.46 MiB PNG fixtures can be staged in one draft and accepted as one Neo message and one work-chat message. This is 20.76 MiB raw before base64, so it directly disproves the old 8 MiB ceiling while preserving every per-file check. No equal-slot recompression or combined-size warning occurs.
- The daemon transcript contains six image blocks in selection order with correct thumbnails/full-image reads. A seventh image and an image over 3.75 MiB still fail locally; a tampered/missing reference is refused before persistence.
- Typed Send, voice Send, and the recording arrow all enforce the same gate in root Neo and work chats. On either side of upgrade, retrying an ambiguous Neo send still produces one request/message. An ambiguous work-chat send stays paused until the user chooses Retry.
- Existing small-image, text-file, draft merge/edit, outbox retry, and visible composer-warning journeys still pass. Report explicit test counts and exit codes; silence is not evidence.

## Source and design checks

- `bun run system-map map`, `where neo.message.send`, `where message.send`, `where neo.conversation.image.read`, `routes .../neo/intake.ts retryNeoIntake`, and `impact` on the proposed daemon files were run. The two proposed new files are not yet mapped; existing send integration points are in Neo intake, legacy session handlers, and app HTTP wiring.
