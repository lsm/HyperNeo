# Phone attachment upload design

Photos start uploading when selected. Send stays available while uploads run. The outbox keeps the message and delivers it once the photos are staged. Keep the six-file and 8 MiB draft limits.

## Phone

- In `Attachment.draftPhoto`, scale the long edge to at most 2,000 pixels without upscaling, then encode as JPEG at quality 0.85. Use pixel dimensions and renderer scale 1. Keep the existing size fallback for unusually large JPEGs. The phone counts base64 length against the 8 MiB draft budget, so keep the existing per-photo fallback ceiling of 1,048,575 JPEG bytes. Six photos at that ceiling fit even after base64 encoding. Keep text files inline with the existing 128 KiB cap.
- Start a PUT after `NeoStore.keepAttachment` saves the bytes through `DraftBook`. Show progress or a retry action on each photo chip. Keep upload status in memory, scoped to the paired daemon and photo hash. Removing a photo removes it from the draft and cancels its local upload if unused.
- Send always queues a sendable draft, including while offline or when an upload is pending or failed. Root Neo, work chat, and voice sends use the existing outbox and local file checks. Connection state gates delivery. Before delivery, `Outbox.attempt` reads and validates the saved blobs as it does today, joins in-flight uploads, and PUTs any image without a fresh success for that daemon and hash. After a restart, it PUTs the saved images again. Upload failures leave the message queued for retry. After awaiting uploads, re-read the entry and confirm it is still pending, has no send in flight, and passes `canSend` on the same paired daemon used for staging. If any check fails, exit the attempt. Otherwise mark it in flight just before the send RPC. Preserve the Neo request ID and the existing manual retry for an unconfirmed work-chat send.
- `DraftBook` and the outbox already save the image bytes, and `StoredAttachment` already records their SHA-256 digest. Use those records as-is, including existing drafts and queued sends.

## Daemon

Add paired `PUT /api/attachments/{sha256}`. Use the paired daemon origin and existing device authentication. Stream the image into a temporary file in the staging directory. Enforce the existing 3.75 MiB raw per-image limit while reading, check the image signature and declared media type, and verify the SHA-256 before atomically publishing under the lowercase hash. Repeated and concurrent PUTs of the same bytes succeed under the same name. A successful PUT records a fresh staging time. Clean up failed temporary writes and sweep staged files and abandoned temporary files after seven days. Clients use recent PUT successes within that window. The paired PUT is the only staging endpoint.

Carry each reference in the existing image block. Keep the image's position and media type.

```json
{
  "type": "image",
  "source": {
    "type": "upload",
    "media_type": "image/jpeg",
    "sha256": "<64 lowercase hex characters>"
  }
}
```

- For `neo.message.send`, accept upload image blocks at intake, including a message with images only. After caller and target admission, resolve them in place to ordinary base64 blocks, then run the existing content validation and mailbox projection before persistence. Keep thumbnail indexes and request-ID replay. If the request was already accepted, check the stored images for the replay instead of staging.
- For work chat, accept the same blocks in the existing `images` array of the legacy `message.send` RPC. Resolve them after session admission and before image size validation and persistence. Both routes keep accepting their existing inline forms.
- Both routes accept at most six image blocks per message, counting inline images, upload references, and every repeat. Check the count before reading staged bodies. Keep the existing per-image limit. Refuse excess blocks and invalid or missing staged images through the existing send refusal path before persistence. The 8 MiB draft budget applies on the phone.

## Three implementation PRs

1. **Daemon upload.** Add the paired PUT, staging, and seven-day sweep. Prove authentication, streaming size and hash checks, duplicate PUTs, and cleanup.
2. **Daemon send.** Resolve upload image blocks in both phone-used paths. Prove photo-only sends, order and thumbnails, missing-file refusal, existing inline sends, and a replay of an accepted Neo request after staging is gone. In both routes, verify that six mixed inline and upload blocks are accepted and that a seventh block, even a repeated hash, is refused before image reads or persistence.
3. **Phone upload and Send.** Normalize new photos before staging, upload on selection, and reuse the outbox to finish uploads before the send RPC. On the merged app and daemon, send six photos in both chat types within the 8 MiB draft budget. Delay uploads and tap Send, then confirm the message queues and arrives once in selection order. While uploads are delayed, verify that Edit and Discard prevent delivery and that switching paired daemons prevents a send on the new connection. Use the same journey to check an upload failure and retry, an offline send across relaunch, and the recording arrow.
