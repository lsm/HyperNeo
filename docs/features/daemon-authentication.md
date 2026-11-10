# Connecting to a daemon

Every `/ws` connection needs a paired-device credential, including connections
through loopback, reverse proxies and a tailnet. Missing, unknown and revoked
credentials receive HTTP 401 before the WebSocket opens. A plain authenticated
GET of `/ws` returns 204; the web app uses it to show pairing when necessary.

- Browsers use the HttpOnly `hyperneo_device` cookie issued by `/pair`. A browser
  without a valid cookie shows the pairing form. Run `hyperneo pair` on the daemon
  machine and open its pairing URL. Already paired browsers keep their cookie.
  Reload an already-open unpaired tab to load the pairing form.
- Native apps keep using their saved device credential as `Authorization: Bearer`.
- Remote daemons use the credential saved when attaching with `daemon.attach`
  and its `code`. An old attachment made without pairing must pair once; its
  address alone no longer grants access.
- Local tools use `local-rpc.credential` in `HYPERNEO_DATA_DIR` (default
  `~/.hyperneo`). The daemon creates this owner-only regular file, registering
  only its hash in the existing device table. The source CLI reads it beside its
  session socket and sends it as Bearer. Local WebSocket scripts must do the same.
  A private Unix socket also requires this credential. Source address and Host
  headers never grant owner access.

The local credential has owner privileges. Do not paste it into messages, logs,
URLs or repository files. Symlinks, another user's files and group/world-readable
credential files are refused. Restart reuses the credential and does not undo
revocation. If explicitly revoked, an OS owner can remove the file and restart
to create a replacement; revoke the old device before replacing a lost file.
Windows uses native file ACLs through built-in Windows PowerShell, rather than
POSIX permission bits, to require the current OS owner and exclude other readers.

Local tools appear in Devices. They do not count as paired human devices for
pairing bootstrap or lost-phone recovery, and resetting human devices keeps the
local recovery door. Existing Allow requirements for later CLI codes remain.

Deploy client and server source together. Update local coordinator scripts to
read this file and send Bearer before restarting a daemon that enforces it. Do
not add an anonymous or loopback fallback. No peer credential grants owner RPC.
