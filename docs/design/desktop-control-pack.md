# Desktop control: one switch and a pack that teaches Neo

## Problem

- Neo told a human to turn on desktop control in a settings page. No such switch exists.
  - Neo had called `desktop.call` itself, and only workers can call it.
  - `neo.todo.add` refuses a desktopControl todo with "turn it on from the todo on the Neo page".
- Workers on v0.60.2 got `target_unverified` because nothing told them every call needs `pid`. #11165 fixes this on dev.
- The global preference `core.desktopControl` already exists, with two values: "allow for tasks that need it" and "manual approval per task". It is asked once on a card and never shown again.
- Neo can use the computer three ways and has no rule for choosing:
  - native desktop control through a local worker;
  - a Codex or Claude Desktop worker with its own computer use;
  - the life-admin pack's Chrome DevTools connection, which reaches page content only.

## Design

1. **A `desktop` pack holds the Neo guidance.**
   - Core keeps the operations, the opt-in rule, the preference and the admission gate.
   - The pack's `instructions()` read cached facts each turn (see Readiness): native ready, fallback ready, and the preference.
   - When neither route is ready, the pack adds nothing. People who never use the computer see no extra prompt.
   - The guidance:
     - Only a worker can call `desktop.call`.
     - Preference "allow": add the todo on a local worker with `named.desktopControl: true`.
     - Otherwise (manual or unset): add the todo with desktopControl omitted. The admission gate refuses true in that case. Then send the existing `desktop_control` card with that todoId and the app, and the human taps Allow. The app-wide grant dialog from #11165 still asks about each app.
     - Use native desktop control for every computer step, browser steps included. Use a fallback worker's own computer use only when native is not ready.
     - When neither is ready, ask the human with the step that fixes it: open HyperNeo Desktop and grant its permissions, or do the step themselves.
2. **One switch on the Desktop control panel** (slice 2).
   - The panel shows whenever the desktop app answers, with zero workers too.
   - The switch reads and writes `core.desktopControl`:
     - on = allow for tasks that need it;
     - off = manual approval per task.
   - Inside the desktop app, turning it on calls the existing `desktop_permission_status` command. If a permission is missing, it opens the existing permissions window, whose button calls `open_desktop_permission_settings`.
   - Outside the desktop app (browser or phone), the panel shows the cached permission status. It says to open HyperNeo Desktop on that Mac to grant what is missing.
3. **Refusals say what to do.**
   - A non-worker caller gets `desktop_worker_only` (#11286).
   - In slice 1, the `neo.todo.add` refusal names the todo's "Let it use this computer" menu item and the Allow card. Slice 2 adds the panel switch to that text and to the pack guidance.
4. **Life-admin drops its Chrome DevTools route** (slice 3).
   - Its instructions point to the desktop pack instead of `chrome-devtools-user`.
   - Chrome DevTools reaches page content only. It cannot click extension popups such as a password manager, or browser dialogs, so tasks stall there.
   - It lands after slices 1 and 2, so readiness and the not-ready path already exist.

## Readiness

- **Native ready** = the desktop app answers a new `status` action on `desktop/control.sock` with both Accessibility and Screen Recording granted.
  - The answer comes from `desktop_permission_status`.
  - Socket reachability alone does not count.
- **Fallback ready** = `work.adapters` lists a Codex Desktop or Claude Desktop adapter with health ok and the start capability.
  - Listed, health-only or degraded adapters do not count.
- The daemon refreshes both facts every 30 seconds and caches them in memory.
- `desktop.status` returns them as top-level `app: {reachable, accessibility, screenRecording}`, which the panel reads.
- The pack's synchronous `instructions()` read the cache.

## Not in scope

- No new preference, table or column. No change to the worker-side opt-in rule.

## PRs

1. The `desktop` pack, the readiness cache and the `status` socket action. The refusal text names the todo menu and the Allow card. This absorbs #11286.
2. The panel switch, plus the permission flow. It adds the switch to the refusal text and the pack guidance.
3. Life-admin instructions switched to the desktop pack.
