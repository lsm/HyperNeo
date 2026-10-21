# In-app previews: web preview shell and safe Markdown links (slice 13)

Build web in the worktree (`cd packages/web && bun run build`), then from the
worktree root, in one owning shell:

```bash
RUN=$(mktemp -d /private/tmp/hn-shell-XXXXXX); RUN=$(cd "$RUN" && pwd -P); mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/opt/homebrew/bin:/usr/bin:/bin" NODE_ENV=test \
  node .claude/skills/verify/preview-shell-web.mjs seed "$RUN"
.claude/skills/verify/launch.sh 9393 "$RUN"
VERIFY_BROWSER=<chrome-headless-shell> NODE_PATH=<directory containing playwright> \
  node .claude/skills/verify/preview-shell-web.mjs web "$RUN" 9393
.claude/skills/verify/stop.sh "$RUN"
```

The seed reuses `preview-register.ts seed` (synthetic todo, worker session and
workspace) and writes `report.md` with a fragment link, a web link, a relative
link, remote/relative/embedded images, a raw `<script>` block and an inline
`<img onerror>`; a 2.3 MB `large.md`; and `page.html`. The web phase registers
them through real `artifact.file.register` RPC and drives headless Chromium at
1280px and 390px on `/neo?artifact=<id>`, aborting every request that leaves the
daemon origin.

It must see: the header with the full title on hover, `Markdown · size ·
worktree snapshot <hash>`; the rendered heading and table; only the embedded PNG
as an image; the relative link as inert text; no sentinel set and no script
element from the file; no run-dir path in the page. Clicking the web link shows
the confirm bar with the full URL and opens nothing; Open link opens one popup.
The only off-origin requests are those two confirmed popups. Source shows the raw
text. The large file shows the 2 MB limit state, HTML shows the no-preview state,
an unknown ID shows the no-longer-available state. At 390px, stopping the daemon
drops the rendered text and shows the daemon-unreachable state; relaunching it
on the same run dir brings the text back without a page reload.

Screenshots and `preview-shell-web.json` land in `$RUN/evidence/`. Unit tests:
`artifact-link-policy`, `artifact-preview-client`, `ArtifactPreview` and
`MarkdownRenderer.artifact`. No provider, credential, live DB or port 8399 is
used. Message/card taps, Back state, HTML, images and downloads are later slices.
