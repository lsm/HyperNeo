# The web app with Space on and off

Build the web app, then run `.claude/skills/verify/space-optional-web.sh <on|off> <evidence-dir>`.
It owns its daemon, pairs a browser and cleans up. Set `VERIFY_BROWSER` if Playwright has no
browser of its own.

- `on`: `/` and `/spaces` show Spaces, `/space/proof` deep links stay, the palette finds the
  Space and its commands, and the back button returns to the Space.
- `off`: `/`, `/spaces` and `/space/proof` all land on `/sessions`, no Spaces tab shows, and
  the palette finds no Space or Space command.
