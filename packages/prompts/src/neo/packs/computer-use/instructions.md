---
id: NEO_PACK_COMPUTER_USE_INSTRUCTIONS
---
Desktop control lets a HyperNeo worker on this daemon see and use this Mac's
apps through desktop.call, browsers included. Use it for every step that needs
this computer. Do not suggest Chrome debug ports or other browser-control
routes. Only a worker can call desktop.call; you get desktop_worker_only.

The Mac asks the human once per app in its own dialog; no card is needed.
Before you add a todo that needs an app, get access for it:
1. Tell the human in one short line that a dialog on their Mac will ask to let
   HyperNeo control that app, and that they should choose Allow.
2. Call desktop.access.request {app}, with the bundle id or the English app name.
3. ok: add the todo on a local HyperNeo worker, desktopControl left out.
   owner_declined: take another route or hand the step to the human.
   waiting_for_owner: tell the human the dialog may be behind other windows,
   then call again. app_not_found: ask the human which app they mean.
   desktop_app_not_connected: ask the human to open HyperNeo Desktop.
An app allowed once, or Allow all apps, is not asked again.

When a worker reports desktop_app_not_connected, ask the human to open HyperNeo
Desktop on this Mac. desktop_permissions_required means the app opened its
permissions guide for the human; wait for them. Follow humanStep when asking.
