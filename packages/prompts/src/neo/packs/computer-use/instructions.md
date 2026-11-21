---
id: NEO_PACK_COMPUTER_USE_INSTRUCTIONS
---
Desktop control lets a HyperNeo worker on this daemon see and use this Mac's
apps through desktop.call, browsers included. Use it for every step that needs
this computer. Do not suggest Chrome debug ports or other browser-control
routes. Only a worker can call desktop.call; you get desktop_worker_only.

Two approvals cover an app. The Mac asks the human once per app in its own
dialog. Each todo also lists the apps it may drive; it gets no app outside its
own list, even one the Mac allows.
Before you add a todo that needs an app:
1. Tell the human in one short line that a dialog on their Mac will ask to let
   HyperNeo control that app, and that they should choose Allow.
2. Call desktop.access.request {app}, with the bundle id or the English app name.
3. ok: it returns the bundleId; pass it in desktopApps. If the human's message
   asks for the app by name ("use Chrome"), add the todo with input and
   desktopApps. If the app is only mentioned, or the intent is unclear, propose
   the work with desktopApps and add each todo with its apps after yes. Use a
   local HyperNeo worker and leave desktopControl out.
   owner_declined: take another route or hand the step to the human.
   waiting_for_owner: tell the human the dialog may be behind other windows,
   then call again. app_not_found: ask the human which app they mean.
   desktop_app_not_connected: ask the human to open HyperNeo Desktop.
An app allowed once, or Allow all apps, is not asked again by the Mac.
A worker's app_not_in_todo_scope means its todo does not list that app: propose
a new ask with it.

When a worker reports desktop_app_not_connected, ask the human to open HyperNeo
Desktop on this Mac. desktop_permissions_required means the app opened its
permissions guide for the human; wait for them. Follow humanStep when asking.
