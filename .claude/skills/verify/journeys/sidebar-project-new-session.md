# A sidebar project's + starts a new session in that folder

Build the web app, then run `.claude/skills/verify/sidebar-project-new-session.sh <evidence-dir>`.
It owns its daemon, adds two projects (`alpha`, `beta`), pairs a browser and cleans up. Set
`VERIFY_BROWSER` if Playwright has no browser of its own; on a host without Node, set
`VERIFY_NODE=bun` and `PLAYWRIGHT_NODE_PATH` to a Playwright install.

- Light and dark, pointer device: no `Add folder` button; each project's `New session in <name>`
  button has opacity 0 at rest, 1 while its row is hovered or keyboard-focused, and clicking it
  leaves `/sessions` showing that project's folder chip. The folder menu then offers
  `Add folder to alpha…`; entering a path closes the form and the new folder appears in the menu.
- The row's `+` and trash (`Remove project <name>`) buttons have the same size, and both gain
  the same `fill` background on hover.
- Open `Add folder to alpha…`, then click beta's `+` while the form is open: the form stays,
  names alpha in its hint, and the path submitted there joins alpha, not beta. The browser
  reads the owner through `workspace.history` right after the add and writes
  `retarget-project.txt`.
- Select the added secondary folder: the menu still reads `Add folder to alpha…`, never
  `Add folder to <folder>…`, and the form hint names alpha.
- Add a project from the open page's sidebar: the page's folder menu lists it without a reload.
- Open `Add folder to <project>…` for a project with no chats, remove that project from the
  sidebar, then submit the form: it stays open, says the project is no longer a project, adds
  nothing, and the project does not come back in the folder menu.
- After the light, dark and touch runs, a last context removes *every* project while the form
  is open and submits it: the form must still refuse, since an emptied history is not a
  missing one. This case runs last because it deletes the projects the earlier steps need.
- Touch device (`hover: none`): the button stays visible.
- Screenshots: `sidebar-{light,dark}-{rest,hover,hover-plus,hover-remove,new-session,folder-menu,folder-added}.png` and
  `sidebar-touch-rest.png`. Run with `TMPDIR=/private/tmp` so folder paths in the sidebar stay generic.
