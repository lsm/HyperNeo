# Live file references A3: sanitized HTML and raster images

Run shared `proof-run.sh` with `.claude/skills/verify/live-file-media-a3.ts` and a
new absolute evidence directory. The helper owns its free-port test daemon and
an ephemeral remote-resource tripwire, uses only synthetic files/HOME/data and
a refusing gh stub, and closes all resources in `finally`. No model or GUI.

`file.reference.read` retains A2 source authorization, anchored safe opens,
reauthorization and versioned chunks. HTML/HTM returns only sanitized UTF-8 bytes,
`kind:html`, `scriptsRemoved` and bounded `links`; clients must render it in an
opaque-origin sandbox. Do not render the source as daemon-origin HTML. No local
stylesheet/image expansion or automatic network fetches. Scripts, handlers,
frames and external assets disappear; ordinary text and valid inline rasters
remain. Inline raster pixel/header checks apply to CSS data URLs too.

Require current HTML A, edited B, stale-version refusal, then missing after
removal. Collect a multi-chunk Unicode HTML document and verify its inert output.
Reject invalid UTF-8, deep/expanded/oversized documents. Standalone PNG/JPEG/GIF/
WebP returns validated MIME/dimensions and original binary bytes; retain the
32 MiB/16-million-pixel limits. SVG, wrong magic/extensions, truncated headers,
empty/oversized and oversized-pixel files refuse. Fixtures include tiny synthetic
raster samples and a valid PNG with a >2 MiB ancillary text chunk. Collect all
chunks byte-exactly, edit the image and reject its old version, then delete/missing.
A fresh process must not reuse old continuation versions for unchanged bytes.

Require zero remote requests and no new artifact/identity rows or blobs. Run
live-file-read/media, legacy HTML, safe-open and policy tests, plus the audited
human-reset coordinator contract. After merge, rerun this isolated daemon proof
from the merge commit and read back the deployed owner build before A3.md.
Actual browser path clicks and sandbox rendering belong to A4; A3 makes no GUI
or paired-human-client claim. No watchers, PDF or cross-daemon reads here.
