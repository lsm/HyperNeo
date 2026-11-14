# Retired Space URLs stay retired

Build the web app, then run `.claude/skills/verify/retired-space-urls.sh <evidence-dir>`.
It owns its daemon, creates a synthetic Space, pairs a browser and cleans up. Set
`VERIFY_BROWSER` if Playwright has no browser of its own.

Opening `/space/<slug>/sessions`, `/tasks/archived`, `/forge` or
`configure/{agents,workflows,settings}` must land on `/spaces`: those redirects were
deleted, so an old bookmark simply finds no Space page. Each entry in
`retired-space-urls.json` records the landed path.

The canonical replacements must still work: `/evolve` shows the Forge view,
`/tasks/completed` presses the Completed tab, and
`/configure/workflow-templates` renders the configure tab bar. `pageErrors` must be
empty; a page error is a failure even when a landed path looks right.
