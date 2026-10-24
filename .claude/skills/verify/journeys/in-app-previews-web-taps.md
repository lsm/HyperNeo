# In-app previews: Neo message and card taps, PR panel and Back (slice 14)

Build web in the worktree (`cd packages/web && bun run build`), then from the
worktree root, in one owning shell (port 9394 here):

```bash
RUN=$(mktemp -d /private/tmp/hn-taps-XXXXXX); RUN=$(cd "$RUN" && pwd -P); mkdir -p "$RUN/home"
ENVI=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/opt/homebrew/bin:/usr/bin:/bin" NODE_ENV=test)
"${ENVI[@]}" bun .claude/skills/verify/preview-taps-seed.ts "$RUN" seed
VERIFY_GH_STUB=preview-git-gh.ts .claude/skills/verify/launch.sh 9394 "$RUN"
PREP=$(node .claude/skills/verify/preview-taps-web.mjs prepare "$RUN" 9394)
.claude/skills/verify/stop.sh "$RUN"
"${ENVI[@]}" bun .claude/skills/verify/preview-taps-seed.ts "$RUN" publish \
  "$(echo "$PREP" | jq -r .root)" "$(echo "$PREP" | jq -c .ref)"
VERIFY_GH_STUB=preview-git-gh.ts .claude/skills/verify/launch.sh 9394 "$RUN"
VERIFY_BROWSER=<chrome-headless-shell> NODE_PATH=<directory containing playwright> \
  node .claude/skills/verify/preview-taps-web.mjs web "$RUN" 9394
.claude/skills/verify/stop.sh "$RUN"
```

The seed reuses the Git capture fixture (todo bound to `github.com/lsm/hyperneo`,
PR #42 at head `aaaaaaa` with `docs/report.md` served by `preview-git-gh.ts`) and
adds `workspace/notes.md`. `prepare` uses real RPC: dev-proxy provider,
`neo.open`, `artifact.file.register` for the notes and `neo.todo.edit` ticking the
todo with that reference. With the daemon stopped, `publish` appends one Neo
publication to the root conversation (the PID lock forbids writing while it runs):
an inline-code `notes.md`, the PR link and the notes as an attached artifact,
linked to the todo.

Headless Chromium at 1280px and 390px, every off-origin request aborted, must see:
the card `Synthetic notes · Markdown · 63 B · Open preview` opens the notes in the
panel (docked right column when wide, bottom sheet with an uncovered strip when narrow); Back closes it with the chat
scroll position unchanged and focus back on the card. Tapping `notes.md` resolves
against that publication to a worktree snapshot; Escape closes. Tapping the PR
link shows the PR summary (title, repository, state, checks, head SHA, inert body,
changed files with a truncation note); its `docs/report.md` opens at
`commit aaaaaaa`; Back returns to the PR and then closes. At 1280px the todo row's
card opens the same notes. No off-origin request is made. A failure leaves
`preview-taps-failure-<width>.png`.

Screenshots and `preview-taps-web.json` land in `$RUN/evidence/`. Unit tests:
`artifact-reference-client`, `ArtifactPreviewPanel`, `MarkdownRenderer.references`,
`NeoArtifactTaps` and `publication-client`. No credential, live DB or port 8399.
