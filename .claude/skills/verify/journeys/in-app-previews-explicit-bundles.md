# Explicit relative CSS/raster bundles (slice 22)

Register each CSS file or PNG/JPEG/GIF/WebP through `artifact.file.register` first.
CSS is an inert text artifact. Register the HTML with an optional `bundle` array:

```json
{
  "requestId": "report-v1",
  "context": {"kind": "todo", "id": "existing-todo"},
  "path": "report.html",
  "title": "Layout report",
  "bundle": [
    {"path": "styles/report.css", "artifactId": "registered-css-id"},
    {"path": "images/chart.png", "artifactId": "registered-raster-id"}
  ]
}
```

The aliases are relative resource names, never filesystem permissions. Every ID
must already name an immutable CSS/raster snapshot in this exact authorized
context. Source registration still uses persisted roots, the anchored no-follow
file descriptor opener, and complete content hashing. No directory crawl, raw
asset path reader, network fetch, script, new endpoint, migration or sharing grant.
The immutable receipt stores the explicit manifest internally; get/read/result
record shapes remain unchanged for older clients. Reordered entries are the same
request; a changed manifest with the same request ID refuses source_changed.

At most 64 entries including HTML and 64 MiB total. HTML preview admits at most
2 MiB combined input and bounds repeated resource expansion before serialization,
then checks the prepared output. Large bundles remain retained; Source/Download
still read the exact original HTML, not a rewritten replacement or ZIP. Registered
assets remain individually readable/downloadable under their existing IDs.

The existing sanitizer inlines only declared CSS/raster snapshots. CSS image URLs
resolve relative to the declared stylesheet name. CSS imports remain disabled;
unlisted, remote, active and unsupported resources stay inert. Both existing HTML
viewers receive a self-contained prepared document, with their unchanged empty
iframe sandbox, disabled scripts, CSP and navigation policies.

## Contracts and real operation proof

From packages/daemon, run Vitest preview-bundle, preview-html, preview-register,
preview-reads plus the existing artifact contracts/policy/capture/descriptor suites.
The new native proof retains synthetic fixtures, checks immutable bytes after
moving originals and reopening SQLite, manifest conflicts, same-context binding,
foreign/unknown/wrong-kind refusals, preview limits, and revocation. Its initial
red run rejected CSS/bundle input and lost relative layout. A separate committed
red regression reproduced repeated-asset expansion before the inlining bound.
Use a supported runtime (Bun 1.4.2 was used), run full checks and build web.

## Isolated daemon and headless web

```bash
RUN=$(mktemp -d /private/tmp/hn-preview-bundle-XXXXXX)
NODE_PATH=<directory-containing-playwright> VERIFY_BROWSER=<headless-Chromium-binary> \
  .claude/skills/verify/preview-bundle-proof.sh "$RUN" 9417
```

The helper owns a metadata-only NODE_ENV=test CLI daemon with fresh HOME/data/DB,
no keys, no provider turn and no model mock. It refuses 8399/busy ports. It seeds
through preview-register.ts, registers all entries via operation.invoke, retains
originals by rename, stops before the existing publication seed, then restarts.
The real Neo message card opens the actual preview at 1280/390px. Require the
stylesheet's green title, decoded orange chart and CSS background, empty opaque
sandbox, no unlisted asset or script, zero off-host requests and exact escaped
Source. The request abort is test isolation; any attempted load fails the proof.
Inspect bundle-preview/source PNGs, bundle-rpc.json, bundle-restart.json,
bundle-web.json and health.json. The EXIT trap stops only its own daemon; keep
all synthetic files and evidence. No unattended headed GUI or live daemon.

## Headless WKWebView rendered-state proof

Use a separate clean iOS worktree and a dedicated simulator, booted with simctl
without opening Simulator.app. With the completed RPC proof above:

```bash
python3 .claude/skills/verify/preview-bundle-ios.py "$RUN" "$IOS_WORKTREE" "$OWN_SIMULATOR"
```

The helper exclusively creates one temporary NeoTests source from the saved
actual RPC source/prepared bytes, runs only BundlePreviewProof with diagnostics
disabled, and removes only that generated source afterward. It changes no iOS
production code. The production sheet/WKWebView renders in en/zh-Hans at 320/402pt;
OCR requires title/final paragraph, and actual snapshot pixels require the green
CSS title and orange raster. Inspect ios-bundle PNGs and ios-bundle-summary.json.
This combines real daemon authorization/byte proof with hosted production native
rendering over AppRig; it does not claim physical taps, a phone or a live native
connection. Delete the dedicated simulator and remove the proof worktree after
preserving evidence. No hostile raw probe or real device is used by this journey.
