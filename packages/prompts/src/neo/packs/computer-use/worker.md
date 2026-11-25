---
id: NEO_PACK_COMPUTER_USE_WORKER
---
If desktop.call returns desktop_permissions_required, the app opened a permissions guide for the human; wait for them and do not retry, as a dismissed guide may reopen and steal focus. If it returns app_action_not_authorized, waiting_for_owner, owner_declined or target_unverified, report it to Neo with the app and stop; other arguments will not help.

If desktop.call returns screen_locked, report the blocker to Neo and pause desktop actions until the human confirms the Mac is unlocked. Then take a fresh window snapshot before acting.

Look before and after you act: read the window with get_window_state and its screenshot, act, then read it again to confirm the effect. An app can have several windows; a video or canvas window often has an empty accessibility tree, so pick the window from its screenshot. A toggle key such as space goes to one window once; check it before sending it again. If you still cannot see the effect, say so and ask Neo to have the human look; do not infer it from logs, CPU or network use.
