# Opt-in artifact Run: isolation contract

Inert Preview stays the default. Opening a card, showing Source, reconnecting or
reopening a panel must not execute artifact code. Run requires an explicit human
click for the displayed artifact revision; closing, disconnecting or replacing
that revision destroys the runtime and returns to Preview. Deploys remain paused.

## This first slice

Pin the existing browser boundary with real cookie/storage denial checks and a
repeatable isolated-daemon journey. This PR enables no Run endpoint or script
allowance. Subsequent slices must satisfy the contract below before exposing Run.

The web currently uses daemon-sanitized HTML in `srcdoc`, `sandbox=""`, and a
script-denying CSP. iOS already has an inert `ArtifactHTMLWebView`: a nonpersistent
store, JavaScript disabled, an empty-sandbox child, resource filtering and a
navigation delegate. The earlier research report's source-only iOS description
is outdated. This slice does not claim a new native rendering or playback proof.

## Origin and authorization

Serve Run on a dedicated HTTPS origin, never the app origin or its `srcdoc`.
Use a separate registrable domain with its own preview subdomain; a sibling
hostname alone can still receive parent-domain cookies ([cookie scope][cookies]).
Local verification uses distinct loopback hostnames, not merely another port.
DNS/TLS and origin configuration are a later deployment step, not part of this PR.

The app authorizes the existing artifact ID and immutable digest. A click may
then create a short-lived, single-use document grant scoped to that digest.
The preview server accepts no app cookies, bearer credentials or arbitrary file
paths; it serves only the granted document, sends no `Set-Cookie`, and exposes no
RPC, proxy or general asset endpoint. Never forward the app's authorization
headers or operation client. Missing origin/containment support leaves Run unavailable.
Responses are non-cacheable, use `Referrer-Policy: no-referrer` and `nosniff`, and
never put artifact bytes or grants in access logs. Grants are not reusable sessions.

## Sanitization and browser policy

Keep bounded HTML parsing, the HTML/CSS allowlist and raster-only embedded assets.
Run needs a separate explicit preparation policy: retain only selected inline
scripts, remove authored CSP, nonces, external script URLs, event attributes,
navigation, forms, frames and remote resources, then assign fresh response nonces.
HTML sanitization does not make the retained JavaScript trustworthy. Do not add a
script-preserving option to the existing inert response by default.

The trusted iframe has exactly `sandbox="allow-scripts"`, never
`allow-same-origin`, plus `referrerpolicy="no-referrer"` and no capability bridge.
An HTTP response policy also applies when the document is opened directly:

```text
default-src 'none'; script-src 'nonce-<fresh-response-nonce>';
script-src-attr 'none'; connect-src 'none'; style-src 'unsafe-inline';
img-src data:; font-src 'none'; media-src 'none'; object-src 'none';
frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none';
sandbox allow-scripts; frame-ancestors <configured-app-origin>
```

The nonce and app origin are generated/validated values, not literal placeholders.
No external CDN, eval, workers, app storage, privileged messages, popups, downloads
or device permissions are granted. Serve policy headers before content; a meta
tag cannot replace HTTP `sandbox`/`frame-ancestors` ([CSP][csp]).

**No-network is a release gate, not a synonym for `connect-src 'none'`.** That
directive covers connection APIs; sandboxing still allows navigation of the
frame itself ([HTML sandboxing][html]). Test self-navigation, redirects, resource
loads, DNS prefetch and WebRTC as well as fetch/WebSocket/beacon. Parent framing
policy and the execution surface's enforced navigation/egress controls must deny
those paths; a sanitizer, API shim or a test request-abort hook is not that guard.
The serving/activation slices must resolve and prove this enforcement before Run
can ship. If a browser surface cannot enforce the contract, keep inert Preview
there; do not silently relax the network rule.

## iOS scope

Keep the existing inert view. A separate native slice adds the same explicit Run
click and revision lifetime, a fresh [`WKWebsiteDataStore.nonPersistent()`][store],
the isolated served document and an opaque sandbox boundary. Install deny-all
resource rules before loading, allow only the host-authorized initial documents,
cancel subsequent navigation/redirects, downloads, authentication challenges and
popups, and install no script-message handlers or file-read grants. JavaScript
can be enabled only in the isolated Run surface after the native security journey
passes; toggling `allowsContentJavaScript` on today's inert view is not the slice.

## Security acceptance and ordered slices

1. **Pin (this PR, zero production lines):** real desktop/mobile browser Preview;
   script and handler canaries stay inert, parent DOM/cookie/storage are denied,
   remote and relative asset attempts stay absent, and Source/reconnect remain safe.
2. **Build (at most 200 production lines per PR):** explicit Run preparation and
   isolated document serving, each from updated dev. Prove cookie-free grants,
   expiry/replay/revocation, exact response headers and all network-denial paths.
   Split further rather than mixing an unproven serving path with activation.
3. **Wire web (at most 200 production lines):** one click starts only the selected
   revision. A local interaction changes the frame, never app state. Before click,
   runtime/grant requests are absent. Test cookie/storage/parent access, every
   network path, reopen/reset, disconnect and unavailable containment in a real browser.
4. **Wire iOS (at most 200 production lines per PR):** the same contract through
   WKWebView, with actual native click/interaction and navigation/resource probes.
   Use at most two booted simulators machine-wide. Web success is not native proof.

Use synthetic content and canaries only. Required CI, exact-head bot approval,
resolved threads and a SHA-pinned manual squash apply to every slice. No deployment
or live-daemon mutation is part of this ladder while deploys are paused.

[cookies]: https://www.rfc-editor.org/rfc/rfc6265#section-4.1.2.3
[csp]: https://www.w3.org/TR/CSP3/
[html]: https://html.spec.whatwg.org/multipage/browsers.html#sandboxing
[store]: https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent()
