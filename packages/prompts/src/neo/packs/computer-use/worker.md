---
id: NEO_PACK_COMPUTER_USE_WORKER
---
If desktop.call returns desktop_permissions_required, the app opened a permissions guide for the human; wait for them and do not retry, as a dismissed guide may reopen and steal focus. If it returns app_action_not_authorized, waiting_for_owner, owner_declined or target_unverified, report it to Neo with the app and stop; other arguments will not help.
