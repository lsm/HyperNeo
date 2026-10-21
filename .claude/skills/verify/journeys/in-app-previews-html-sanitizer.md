# In-app previews: HTML sanitizer and CSP wrapper (slice 15)

`artifact.file.html {artifactId}` returns a registered HTML snapshot (at most
2 MiB, same authority as `artifact.file.read`) as an inert preview document, so
web and iOS can render the same bytes. The daemon parses the page
(`hast-util-from-html`) and rebuilds it from an element/attribute allowlist
(`packages/daemon/src/lib/artifacts/html-preview.ts`):

- removed with their content: scripts, noscript, templates, frames, objects,
  embeds, SVG, MathML, form controls, media, authored `meta`/`link`/`base`;
- unknown elements, anchors and forms are unwrapped and keep their text; every
  `on*` attribute, `href`, `srcset` and any attribute off the allowlist is dropped;
- images survive only as `data:` PNG/JPEG/GIF/WebP; CSS keeps inline layout but
  loses `@import` and non-raster `url()`, and a stylesheet with escapes,
  `expression()`, `image-set`, `@font-face` or `javascript:` is dropped whole;
- the head is rebuilt: charset, then the host CSP from the design, then only the
  page's `title` and cleaned `style`. Comments and the doctype are regenerated.

`links` lists the page's http(s)/mailto targets for the host to offer outside
the frame; `scriptsRemoved` tells the host to show "Scripts disabled". Non-HTML
artifacts return `unsupported_type`, oversized ones `size_limit`.

Unit contract (Vitest): `tests/unit/1-core/operations/preview-html.test.ts`
covers script tags, handlers, javascript:/data: URLs, remote assets, forms,
frames, meta refresh/authored CSP/base, CSS url/import/expression/escapes, SVG
and MathML, template/noscript and a wrapper breakout, and runs
`.claude/skills/verify/preview-html.ts` under actual Bun for the operation
(registration, refusals, foreign caller).

Isolated daemon proof, in one owning shell with a stop.sh trap:

```bash
RUN=$(mktemp -d /private/tmp/hn-html-preview-XXXXXX)
mkdir -p "$RUN/home" "$RUN/evidence"
E=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" NODE_ENV=test)
"${E[@]}" bun .claude/skills/verify/preview-html-rpc.ts "$RUN" seed
.claude/skills/verify/launch.sh 9386 "$RUN"
"${E[@]}" bun .claude/skills/verify/preview-html-rpc.ts "$RUN" capture 9386
.claude/skills/verify/doctor.sh 9386 "$RUN"
.claude/skills/verify/stop.sh "$RUN"
.claude/skills/verify/launch.sh 9386 "$RUN"
"${E[@]}" bun .claude/skills/verify/preview-html-rpc.ts "$RUN" restart 9386
.claude/skills/verify/stop.sh "$RUN"
```

`capture` registers a synthetic hostile page through `operation.invoke`, checks
the returned document is CSP-first with every hostile construct gone and the
text kept, and that Markdown and unknown IDs are refused. `restart` returns the
identical document after a daemon restart. Evidence: `RUN/evidence/html-rpc*.json`.

Not proven here: no browser or WKWebView renders the document yet. The
opaque-origin `iframe sandbox=""` (web, slice 16) and the WKWebView wrapper
(iOS, slice 20) are the containment boundary and need human-guided proof there.
Synthetic data only; no credentials, live DB, port 8399 or unattended GUI.
