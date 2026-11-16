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
filler asks. It opens `/neo` at 1280px, then at 390px with touch. When the
work list has an "In progress" state chip, it clicks that chip before opening
rows.

Pass means the helper exits 0 and `where-observations.json` shows:

- no switch visible before any row is expanded;
- every seeded todo row rendered with a chevron, and after the chevron is
  pressed (tapped at phone width) its switch is visible, enabled and passes an
  unforced trial press that leaves its value unchanged, at both widths;
- `desktopReachableWhenObstructed` and `phoneReachableWhenObstructed` are
  `false`: the same check fails once a transparent overlay covers the page.
- `phoneWorkButton` names the header button that opens the work sheet.

Negative control: `VERIFY_OBSTRUCT_SWITCH=1` covers each switch before it is
checked, and the helper must exit non-zero.

Screenshots show the click path: `desktop-1280-errands-collapsed.png`,
`desktop-1280-errands-expanded.png`, `phone-390-page.png` (the header button),
`phone-390-work-sheet.png` and `phone-390-errands-expanded.png`.

Not covered: turning the switch on (see `desktop-control-toggle.md`), the native
phone app, and todos bound to a remote daemon, which never show the switch.
