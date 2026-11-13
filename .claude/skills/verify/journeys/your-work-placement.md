# Your work shows once beside the tabs panel

Build web in the worktree (`cd packages/web && bun run build`), then from the
worktree root, in one owning shell:

```bash
RUN=$(mktemp -d /private/tmp/hn-yw-XXXXXX); RUN=$(cd "$RUN" && pwd -P); mkdir -p "$RUN/home" "$RUN/evidence"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/opt/homebrew/bin:/usr/bin:/bin" NODE_ENV=test \
  bun .claude/skills/verify/preview-register.ts "$RUN" seed
.claude/skills/verify/launch.sh 9394 "$RUN"
VERIFY_BROWSER=<chrome-headless-shell> NODE_PATH=<directory containing playwright> \
  node .claude/skills/verify/your-work-placement-web.mjs "$RUN" 9394
.claude/skills/verify/stop.sh "$RUN"
```

The seed gives the Neo page one synthetic work card. The helper pairs a headless
browser through `/pair`, opens `/neo` at 1600px and 2600px, and opens the right
tabs panel with the card's Open button.

It must see, at both widths with the panel closed, the chat and the Your work
column and no Your work tab. At 1600px with the panel open, the column is
hidden and Your work is the first tab. At 2600px with the panel open, three
columns: chat, the Your work column, and the panel with no Your work tab.

Screenshots and `your-work-placement.json` land in `$RUN/evidence/`. Unit tests:
`NeoPreviewWork` and `NeoLiveWorkScenes`. No provider, credential, live DB or
port 8399 is used.
