## Coding pack settings page

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/coding-pack-settings.sh "$RUN" 9393
```

Use a fresh absolute synthetic run directory and a free port other than 8399. The
helper starts the daemon from `env -i` with NODE_ENV=test, a synthetic HOME, data
dir and DB, and a GitHub stub; no provider credential is created. Set
`VERIFY_BROWSER` to an installed Chromium executable when Playwright's own browser
is unavailable. The browser always runs headlessly.

It seeds pack-global `mergePolicy=review_bot` and `reviewBot`, plus an explicit
empty `humanSignoff` for `acme/app`, through `pack.preferences.set`. It then opens
Settings > Coding pack from the nav and checks: pack global shows its saved
values and leaves `humanSignoff` unanswered; `acme/app` shows the inherited merge
policy and its own empty sign-off list; another repo stays unanswered; opening and
switching scope leave `pack.preferences.list` unchanged; an unsaved sign-off draft is dropped when the repository changes; no Reset/delete control
exists. An invalid review bot login shows the daemon's refusal and the saved value
is kept. Saving no sign-off paths at pack global stores `[]` (other repos then
inherit it), and picking `CI passes` for `acme/app` reads back at repo scope while
pack global stays `review_bot`. Each control fits at 1280 and 390 px. Evidence:
`evidence/coding-pack-settings.json` and the desktop/mobile PNGs.

The page writes through the local-human RPC door. Agent writes are refused by the
`human_only` policy; [pack settings operations](pack-settings-operations-slice-2.md)
proves that refusal.

The instance watch list must start empty and opening the page must not write it.
While viewing repository policy, save `acme/app` and `other/repo` as watches:
readback must be at pack-global scope, with duplicates/case normalized. Reload
keeps those choices. An invalid repository is refused without replacing the
saved list. Clearing the field stores `[]`, and reload stays empty. The desktop
and mobile screenshots show the saved list and controls fitting the viewport.
The helper also retains the initial screenshot so the missing-control regression
can be inspected. No automatic repository enrolment is exercised.

Keep the form open with an unsaved watch edit, then forget a synthetic project
through the real RPC operation. Save must warn that watches changed elsewhere,
refresh the list, and leave the forgotten repository unwatched. The helper
retains `coding-watch-stale-save.png` plus `afterStaleSave`/`staleSaveRefused` in
the evidence. A new save based on the refreshed list remains usable. This checks
a stale form against a completed change; it does not claim atomic compare-and-set
between concurrent clients.
