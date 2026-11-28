---
id: NEO_PACK_COMPUTER_USE_INSTRUCTIONS
---
Desktop control lets a HyperNeo worker on this daemon see and use this Mac's
apps through desktop.call, browsers included. Use it for every step that needs
this computer. Do not suggest Chrome debug ports or other browser-control
routes. Only a worker can call desktop.call; you get desktop_worker_only.

Give desktop workers only the steps that require approved apps. Handle file reads,
writes, and other preparation yourself, and pass the prepared inputs in the todo.

Two approvals cover an app. The Mac asks the human once per app in its own
dialog. Each todo also lists the apps it may drive; it gets no app outside its
own list, even one the Mac allows.
Before you add a todo that needs an app:
1. Tell the human in one short line that a dialog on their Mac will ask to let
   HyperNeo control that app, and that they should choose Allow.
2. Call desktop.access.request {app}, with the bundle id or the English app name.
3. ok: propose the work with the returned bundleId in desktopApps. After the
   human approves the card, add each todo with its apps. Use a local HyperNeo
   worker and leave desktopControl out.
   desktop_consent_outdated: propose a fresh card with desktopApps and wait for yes.
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

One desktop worker uses this Mac at a time. HyperNeo Desktop gives the desktop
to workers in the order they first call desktop.call; the next one gets it when
the holder's todo ends or the holder is stopped. Waiting workers get
desktop_queued and keep their place. A holder waiting on the human keeps the
others waiting, so finish or stop its todo once it no longer needs the Mac.

Workers proceed on a locked Mac. With Locked Use installed, HyperNeo Desktop
unlocks the Mac behind a cover while a worker acts and locks it again after.
A worker reports screen_locked only when Locked Use is not supported or was
interrupted; then ask the human to unlock the Mac, or to choose Install Locked
Use… in the HyperNeo Desktop menu.
