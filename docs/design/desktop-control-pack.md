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
   - Core keeps the operations, the opt-in rule and the preference.
   - The pack's `instructions()` read facts each turn, as delegation does:
     - whether the desktop app is connected (see "App connected" below);
     - the preference value;
     - whether `work.adapters` lists a Codex Desktop or Claude Desktop adapter.
   - When the desktop app is not connected and neither adapter is listed, the pack adds nothing. People who never use the computer see no extra prompt.
   - The guidance:
     - Only a worker can call `desktop.call`. Neo adds the todo with `named.desktopControl: true` on a local worker.
     - When the preference is not "allow", Neo sends a `desktop_control` question and the human taps Allow.
     - Use native desktop control for every computer step, browser steps included.
     - Use a Codex or Claude Desktop worker's own computer use only when native control is unavailable.
     - Say once to the human what they must tap.
   - The pack is on by default. It costs nothing when the app is absent.
2. **One switch on the Desktop control panel.**
   - The panel shows whenever the desktop app is connected, not only while a worker runs.
   - Its switch reads and writes `core.desktopControl`, the same fact the card asks for:
     - on = allow for tasks that need it;
     - off = manual approval per task.
   - Turning it on when the app reports `desktop_permissions_required` opens the macOS Accessibility and Screen Recording prompts through the desktop app.
3. **Refusals say what to do.**
   - A non-worker caller gets `desktop_worker_only` (#11286).
   - The `neo.todo.add` refusal names the panel switch and the todo's "Let it use this computer" menu item, not "the Neo page".

4. **Life-admin drops its Chrome DevTools route.**
   - Its instructions point to the desktop pack instead of `chrome-devtools-user`.
   - Chrome DevTools reaches page content only. It cannot click extension popups such as a password manager, or browser dialogs, so tasks stall there.
   - One route means one set of grants and one way to stop and take over.

## App connected

- No operation reports this today. `desktop.status` lists only opted-in workers, and it probes `desktop/control.sock` only for them.
- The daemon probes `desktop/control.sock` with the existing `appListening` check every 30 seconds, and caches the result in memory.
- `desktop.status` returns that value as a top-level `app` field, which the panel reads.
- The pack's synchronous `instructions()` reads the cached value.

## Not in scope

- No new preference, table or column. No change to the worker-side opt-in rule.

## PRs

1. The `desktop` pack: guidance moved out of core prompts, plus the refusal text. This absorbs #11286.
2. The panel switch, plus the permission prompt.
3. Life-admin instructions switched to the desktop pack.
