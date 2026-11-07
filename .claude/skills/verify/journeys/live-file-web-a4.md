# Current files from web path taps (A4)

This replaces the browser phase of `in-app-previews-web-taps.md`. Keep its
synthetic legacy artifact and Git fixtures: current local paths use
`file.reference.read`, while artifact IDs and SHA-bound Git captures stay on
separate readers. No real account, credential, database or provider is used.

Build web, then use shared launch/stop from SKILL.md in one owning shell. Choose
two free ports other than 8399; Playwright must be installed outside production
dependencies. NODE_PATH locates it; VERIFY_BROWSER may name an installed headless
Chromium. Keep the shell alive throughout an interactive browser run.

```bash
set -e
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hn-live-web-a4-XXXXXX")
RUN=$(cd "$RUN" && pwd -P)
mkdir -p "$RUN/home" "$RUN/evidence"
TASK_BUN=$(command -v bun)
TASK_NODE_BIN=$(dirname "$(command -v node)")
ENVI=(env -i HOME="$RUN/home" PATH="$(dirname "$TASK_BUN"):$TASK_NODE_BIN:/usr/bin:/bin:/usr/sbin" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
trap '.claude/skills/verify/stop.sh "$RUN"' EXIT
"${ENVI[@]}" bun .claude/skills/verify/live-file-web-a4-seed.ts "$RUN" seed
VERIFY_GH_STUB=preview-git-gh.ts .claude/skills/verify/launch.sh "$VERIFY_PORT" "$RUN"
"${ENVI[@]}" node .claude/skills/verify/preview-taps-web.mjs prepare "$RUN" "$VERIFY_PORT" > "$RUN/evidence/prepared.json"
.claude/skills/verify/stop.sh "$RUN"
"${ENVI[@]}" bun .claude/skills/verify/live-file-web-a4-seed.ts "$RUN" publish \
  "$(jq -r .root "$RUN/evidence/prepared.json")" "$(jq -c .ref "$RUN/evidence/prepared.json")"
VERIFY_GH_STUB=preview-git-gh.ts .claude/skills/verify/launch.sh "$VERIFY_PORT" "$RUN"
VERIFY_BUN="$TASK_BUN" node .claude/skills/verify/live-file-web-a4-proof.mjs "$RUN" "$VERIFY_PORT"
```

Set VERIFY_MOCK_PORT to the second unused port before launch. The proof creates
fresh browser contexts at 1280 and 390 pixels, clicks actual Neo publication
paths, edits an inactive file then selects/reopens it, deletes and reopens it,
and verifies current sanitized HTML and changed PNG pixels. Every live request
must retain the publication source/reference; no registration or snapshot resolve
is allowed. File and identity row counts stay unchanged during these reads.
Download rereads the current file: all 450,016 bytes must match the synthetic
edited text. HTML download is explicitly safe/sanitized HTML, not original active
source. Unsupported PDF paths stay plain text. Legacy artifact cards and the
fixed-head Git file/Back flow still work; off-origin requests and page errors fail.

For interactive QA, import `verifyLiveFilePage` from the proof module through the
playwright-interactive skill, pass an owned page and `{run, base, width, bun}`,
and keep contexts/browser available for inspection. Inspect desktop and phone
screenshots separately. Screenshots await the sheet's finite opening animation;
check full image visibility, wrapped path text, tabs, Download, Back and the missing
file message. Explore Escape/focus, keyboard tab switching and close while loading.
Run LiveFilePreview, live-file-client and existing preview/navigation/reference
unit suites for stale results, disconnect, bounds, UTF-8 splits and cancellation.

This isolated journey proves the real web/daemon path. After merge, record owner
build/PID/health and the merged-version rerun. The separately recorded deployed
human-click acceptance belongs to A4: ask the maintainer to publish a synthetic
persistent file reference and have the paired human click it once. Do not borrow
credentials or drive the human's own browser to manufacture that acceptance.
Keep evidence local; stop owned browser contexts and the test daemon/mock.
