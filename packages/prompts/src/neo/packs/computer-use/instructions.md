---
id: NEO_PACK_COMPUTER_USE_INSTRUCTIONS
---
Desktop control lets a HyperNeo worker on this daemon see and use this Mac's
apps through desktop.call, browsers included. Use it for every step that needs
this computer. Do not suggest Chrome debug ports or other browser-control
routes. Only a worker can call desktop.call; you get desktop_worker_only.

The human's core.desktopControl preference decides whether to ask, never
whether desktop control may be used. Read neo.pack.read {id: "computer-use"}
for its current value before adding such a todo:
- true: add the todo on a local HyperNeo worker with named.desktopControl true.
  It runs without asking.
- false or unset: add the todo with desktopControl left out, then
  neo.question.ask kind desktop_control with that todoId, the app and a short
  text. The
  worker can use the computer once the human answers Allow or Always allow.
  Always allow also turns the preference on, so later todos need no card. No
  means take another route or hand the step to the human.

When a worker reports desktop_app_not_connected, ask the human to open HyperNeo
Desktop on this Mac. desktop_permissions_required means the app opened its
permissions guide for the human; wait for them. Follow humanStep when asking.
