# Reach the desktop-control switch on the Neo page

The "Let the agent use this computer" switch lives inside an expanded todo row,
not on the card face. This journey proves a human can still reach it at desktop
and phone widths, for doing, blocked and not-started todos, so a Neo page
redesign cannot hide it silently.

Run from the worktree root with a fresh web build:

```bash
cd packages/web && bun run build && cd ../..
NODE_PATH=<directory containing playwright> TMPDIR=/private/tmp \
  bash .claude/skills/verify/desktop-control-where.sh /absolute/evidence/dir
```

The helper launches an isolated daemon and seeds synthetic work
(`desktop-control-where-seed.ts`): one ask with a doing, a blocked and a
not-started todo, one ask with an open question and a doing todo, and five
filler asks. It opens `/neo` at 1280px, then at 390px with touch.

Pass means the helper exits 0 and `where-observations.json` shows:

- no switch visible before any row is expanded;
- every seeded todo row rendered with a chevron, and its switch visible after
  the chevron is clicked, at both widths;
- `phoneWorkButton` names the header button that opens the work sheet.

Screenshots show the click path: `desktop-1280-errands-collapsed.png`,
`desktop-1280-errands-expanded.png`, `phone-390-page.png` (the header button),
`phone-390-work-sheet.png` and `phone-390-errands-expanded.png`.

Not covered: turning the switch on (see `desktop-control-toggle.md`), the native
phone app, and todos bound to a remote daemon, which never show the switch.
