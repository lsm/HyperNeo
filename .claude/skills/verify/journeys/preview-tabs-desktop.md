# Preview tabs and buttons take clicks in the desktop app

Use the pinned runtime and isolated daemon setup in ../SKILL.md. Build the web
bundle at the checked-out head, then from the worktree root:

```sh
VERIFY_BROWSER=<chromium> VERIFY_PLAYWRIGHT=<playwright-package> VERIFY_MOCK_PORT=29367 \
  bash .claude/skills/verify/with-run.sh bash .claude/skills/verify/preview-tabs-desktop.sh \
  29366 <before|after> <absolute-evidence-directory>
```

The seed gives the Neo page one synthetic work card. The helper pairs a headless
browser at 1600px, sets `window.isTauri` so the page takes the desktop app layout
(including its title-bar drag strip), opens In progress and the card's Open
button, and checks what sits under the centre of every tab and button in the
preview panel.

On the base, it exits 1: the drag strip covers Close, Expand, Your work, the
document tab and its close button. After the fix, every control receives its own
click, and a real mouse click on Your work selects it. The page shows no Back to
chat button on desktop.

`preview-tabs-desktop.json` and the `<phase>-closed`, `<phase>-open` and
`<phase>-work-clicked` PNGs land in the evidence directory. A headless browser
cannot drag a native window, so this proves what receives the click, not the drag
itself.
