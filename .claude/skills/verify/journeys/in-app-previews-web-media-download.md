# Web image, JSON, log previews and complete downloads (slice 17)

Build web, then use the shared isolated launch/doctor/stop setup in SKILL.md.
Use a new RUN directory and an unused port other than 8399. No live data or
headed GUI. NODE_PATH must locate Playwright; VERIFY_BROWSER may point to its
headless Chromium binary. From the worktree root, in one owning shell:

```bash
RUN=$(mktemp -d /private/tmp/hn-media-XXXXXX)
mkdir -p "$RUN/home" "$RUN/evidence"
trap '.claude/skills/verify/stop.sh "$RUN"' EXIT
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/opt/homebrew/bin:/usr/bin:/bin" NODE_ENV=test \
  node .claude/skills/verify/preview-media-web.mjs seed "$RUN"
.claude/skills/verify/launch.sh 9397 "$RUN"
node .claude/skills/verify/preview-media-web.mjs web "$RUN" 9397
.claude/skills/verify/doctor.sh 9397 "$RUN" > "$RUN/evidence/doctor.txt"
```

The script registers synthetic JSON, a raster PNG, a pixel-limit PNG and a large
log through the real operations. At 1280 and 390 widths, open the actual Neo
preview panel: observe formatted escaped JSON, Copy visible, image fit/original
size, oversized image refusal without decoding, and bounded log head/tail with
exact omitted-byte count. Download complete file must produce the original log's
full size and SHA-256. No off-origin request may occur. Inspect screenshots and
media-web.json under RUN/evidence and include them in the PR. Download transfer
is sequential with bounded authenticated reads; the browser retains at most the
registration size limit in memory until integrity passes, then saves explicitly.

Repeat the web command with `VERIFY_PLAIN_HTTP=1` to use the synthetic
`preview.invalid` host mapped to loopback only in headless Chromium. The proof
asserts `isSecureContext === false`: image preview and integrity-checked full
download must still work without Web Crypto. Clipboard readback is unverified
on that origin; the UI reuses the existing copyToClipboard fallback.

Run artifact-media-client plus existing artifact component/client tests for
cancel between chunks, hash mismatch, revocation and disconnect cleanup. Cancel
stops subsequent reads; an already in-flight authenticated RPC may finish but its
bytes are discarded. Image buffers/object URLs and download buffers live only in
the mounted connected view. No iOS or human-guided device security proof is
claimed by this headless web journey. Stop only the owned daemon/mock/browser.

Run with `VERIFY_FAULTS=1` to proxy only this synthetic browser's WebSocket and
replace one artifact read request with a transient RPC error, keeping the real
connection alive. The actual preview must show daemon-unavailable, never revoked.
A second injected error during Download must preserve the loaded JSON and show
an inline Retry download. Retry must save the exact original bytes. Screenshots
capture both states at both widths; the original red UI output is retained.
Typed authorization refusals still clear the preview (component/client tests).
The helper also proves the current daemon rejects SVG registration with
unsupported_type; this slice claims raster previews only, with no SVG Source.
