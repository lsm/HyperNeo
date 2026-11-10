# Current video file reads

Run `live-file-video.ts` through `proof-run.sh` with pinned Bun, a scrubbed test environment and a fresh evidence directory. It owns a random-port daemon, synthetic stored references, HOME and database. No model or external requests are needed.

Verify MP4 and modern QuickTime MIME detection, exact multi-chunk reconstruction, EOF and invalid ranges, the 16 MiB boundary and over-limit refusal before reading bytes. A recorded read seam must show only the bounded header and requested range through one descriptor. Reject malformed or mismatched headers, private paths, symlinks, traversal, unmentioned references and foreign owners. Editing a source invalidates continuation versions. Mid-read changes and revoked source authority withhold bytes. No artifact rows or blobs are created.

Run the existing live-file read and media journeys to preserve document and raster behavior. Clickable video links and playback remain gated until the client slices.
