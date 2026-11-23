# Share origin for copied links

In the desktop app, Copy link on an ask card emits `location.origin`, which is the
loopback address. The link does not open on another device.

## Decision

The daemon's share origin is the existing `HYPERNEO_PUBLIC_URL` environment value
(`PUBLIC_URL` as the existing alias). Nothing else is a share origin.

Why this one:

- It is the only setting that is already a full origin: scheme, host and port.
- It is already validated: a valid URL, and HTTPS unless it points at loopback.
- It is a statement by the operator about how this daemon is reached. Allowed hosts
  is a list with no scheme or port. The CLI Tailscale probe only checks that Serve
  listens on 443, not that it routes here. Phone pairing and the web page's
  `location.origin` describe how one client reached the daemon, not how others can.

## Behaviour

- The daemon exposes the validated value in the system state the web app already
  loads, as `shareOrigin`, or null when unset or invalid.
- Copy link uses `shareOrigin` when set, otherwise `location.origin` as today.
- When unset, the Copy link menu entry is unchanged, and the toast after copying
  says the link only opens on this device.
- The GitHub webhook path keeps reading the same variable. Its validation moves to
  one shared function so both callers agree.

## Out of scope

No new setting, settings UI, Tailscale discovery, or per-device origin. Other
links built from `location.origin` (pairing QR, settings pairing link) keep their
current meaning: they are for the client that is asking.
