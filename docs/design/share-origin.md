# Share origin for copied links

In the desktop app, Copy link on an ask card emits `location.origin`, which is the
loopback address. The link does not open on another device.

## Decision

The share origin is the existing `HYPERNEO_PUBLIC_URL` value (`PUBLIC_URL` alias),
read as an operator statement of where this daemon is reached. It is the only
setting that holds a scheme, host and port. Allowed hosts has no scheme or port,
the Tailscale probe only checks that Serve listens on 443, and `location.origin`
describes one client's route, not everyone's.

The setting was introduced for the GitHub webhook and a working webhook proves only
that one POST route is reachable. So the operator, not the daemon, vouches that the
origin serves the same authenticated routes the web app uses, including
`GET /ask/<id>.md`. Cross-device sharing needs that to be true. The daemon does not
check it.

## Shape

- `shareOrigin` is the parsed origin only: `http` or `https`, host and port, with no
  userinfo, path, query or fragment. It appears in the authenticated system state
  the web app already loads, and in the copied link.
- It is null when the variable is unset, not a valid URL, or not `http(s)`.
- The webhook keeps reading the variable as today, with its path join, HTTPS rule
  and error messages unchanged. Routing, allowed hosts and pairing do not read
  `shareOrigin`.
- Copy link uses `shareOrigin` when set, otherwise `location.origin` as today.
  There is one fallback and no warning logic: a loopback value set by the operator
  is used as given.

## What the link does for a recipient

The link is only a URL. A recipient's browser has its own credentials, and a paired
native app's credentials do not carry over. Opening the link in a browser that is not
yet paired with that origin requires pairing there first.

## Wording when unset

The Copy link toast makes no claim about reach. It says the link uses this
window's address, and the doc for the setting says to set `HYPERNEO_PUBLIC_URL` to
share across devices.

## Scope

Only the ask-card Copy link (`NeoAskTodos.tsx`, destination `/ask/<id>.md`) is in
scope. There is no session Copy link in the web app today, so session links are
deferred until one exists.

The pairing QR and settings pairing link keep `location.origin`: they are for the
client that is asking. No new setting, discovery or per-device origin.
