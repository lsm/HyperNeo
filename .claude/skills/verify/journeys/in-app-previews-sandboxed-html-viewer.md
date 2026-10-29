# In-app previews: sandboxed web HTML viewer (slice 16)

Requires merged slices 13–15. Reuse the existing file preview panel and
artifact.file.html, not a second sanitizer or raw-path reader. The HTML response
is paired with authorized metadata by SHA-256 and mounted only as srcdoc in an
iframe with sandbox="" and referrerpolicy="no-referrer". No allowance, bridge,
operation client, cookie or host DOM access is passed to content. The trusted CSP
is supplied by the existing daemon sanitizer. This journey verifies the inert default. Opt-in Run has a separate isolation
contract in `docs/design/artifact-run-isolation.md`; it must not relax Preview.

The scripts-disabled notice and external-link actions live in trusted host DOM.
External links require the same explicit confirmation as Markdown links. Source
reads the registered original only when selected, and displays it as escaped
text. A sanitizer depth refusal keeps Source available for documents within the
preview limit. Disconnection or read revocation removes frame and source buffers.
General streamed downloads are slice 17; no hidden content transfer is added.

QA inventory: static layout plus embedded raster at 1280 and 390 pixels; inert
script/handler/javascript URLs; no authored top navigation, form, popup, refresh,
base, iframe or external loads (including same-origin relative image probes);
opaque parent DOM access; native details toggle; trusted link confirmation and
Cancel; escaped Source; sanitizer-limit source fallback; connection loss and
dismissal reuse the existing shell/panel lifecycle. Tests must fail before wiring.

Unit tests: ArtifactHtmlViewer, ArtifactHtmlDocument, ArtifactHtmlSource,
artifact-html-client and prior preview/Markdown/panel suites. Full checks, web
build and the daemon's preview-html tests remain required.

Build web, then run the repeatable proof from the worktree root. The wrapper
uses shared `with-run.sh` isolation and an owning stop.sh/evidence EXIT trap. VERIFY_BROWSER points to a headless Chromium
binary and NODE_PATH to a directory containing Playwright; no headed GUI.

```bash
VERIFY_NODE=/path/to/node NODE_PATH=/path/to/node_modules \
VERIFY_BROWSER=/path/to/chromium VERIFY_MOCK_PORT=19395 VERIFY_PORT=19396 \
  bash .claude/skills/verify/preview-html-viewer-check.sh /absolute/new/evidence
```

The runner applies the shared macOS resource guard only on Darwin. Run
`python3 .claude/skills/verify/preview-html-viewer-preflight.py` to exercise the
actual entrypoint with platform/tool shims: Linux reaches seed setup without
`memory_pressure`, while Darwin stops before setup below 25% free memory.
This preflight regression does not establish native Linux browser coverage.

The seed creates only a synthetic DB/context/workspace with hostile.html and a
synthetic deep document. Prepare registers them and opens Neo through real
operation.invoke. Stop the daemon before seeding the synthetic publication into
its own DB; then restart. Web taps the actual publication card and tests the current tabbed desktop
panel and compact phone panel. Panel metadata is not assumed to be a heading;
the expected artifact heading is verified inside the frame. It checks content in the sandbox and records screenshots.
Every off-origin request and relative asset probe is recorded and aborted; any
attempt fails the proof (the abort is test isolation, not the containment guard).
It seeds synthetic host-only cookie/local/session storage canaries, confirms they
exist in the app and requires SecurityError for each in the frame.
It confirms the static heading/image, opaque origin, no sentinel in parent or
frame, no active authored navigation and no popups/dialogs. It deliberately
replaces only that same test frame's srcdoc with unsanitized probe content without
CSP: script/handler execution, user-clicked top navigation, popup and form submit
must still be denied by sandbox="". This mutation is a negative containment test,
not a product path. It restores the daemon-prepared document for screenshots.
Escape dismisses the desktop/compact web panel and restores focus/scroll. On narrow screens,
stop/restart drops the frame then rereads it without reloading the app. Source
controls are exercised on the existing standalone `/neo?artifact=<id>` route,
where Source must retain all original bytes as text and Back returns to `/neo`.
The tabbed/compact panel does not expose those standalone Source controls. Screenshots and html-viewer-web.json stay under
RUN/evidence; inspect them before attaching screenshots to the PR. Stop owned
services/browser; retain synthetic evidence. Never use port 8399, a live DB,
auth/credential files, real GitHub/providers or unattended GUI automation.
