# Daemon security: pairing, Origin/Host checks, loopback by default

Status: approved for #7975. S1 is merged; later slices are not built yet.
Nobody has checked the phone's saved address, the live listen address or the Tailscale
ACLs. This design does not touch them; the migration below decides when they change.

## Today

- **Listen address.** The daemon listens on `0.0.0.0:9283` by default (`config.ts:105`). Only `HOST`/`--host` changes it.
- **`/ws` upgrade.** The daemon (`app.ts:1116`) and all three CLI front doors upgrade `/ws` with no check of any kind: `prod-server.ts:159`, `dev-server.ts:210`, `prod-server-embedded.ts:141`. Preflight answers `Access-Control-Allow-Origin: *`.
- **Caller identity.** Every RPC caller becomes the local human. `rpc-adapter.ts:24` stamps `principal: 'local'`, which passes `requireLocalUser` and the inline `principal === 'local'` gates. About 200 raw `onRequest` handlers take no caller at all.
- **Peer daemons.** A peer daemon attaches by a bare `ws://`/`wss://` URL with no token (`remote-daemons/registry.ts:22`), and the receiving daemon treats its calls as the local human.
- **Session door.** The unix socket `session-door.sock` is chmod'ed to `0600` only after `listen`, and it takes the sender session from the request body.
- **GitHub webhook.** The only route with real authentication: `POST /webhook/github/space` checks an HMAC signature.

## Threat model

Protects against:
- anyone on the LAN, Tailscale tailnet or Internet path who can reach the port;
- a web page in any browser on a machine that can reach the daemon, which could otherwise open `/ws` itself (cross-site WebSocket hijacking or DNS rebinding);
- a stolen or lost phone or laptop, by letting the human revoke it;
- a peer daemon acting as the human;
- an AI session on this machine pairing a device for itself, even under prompt injection. Agent sessions are handed the session door, so once any device is paired, every new pairing code needs the human's Allow on a paired device.

Out of scope:
- a process running as the same OS user, which can already read the database and drive the CLI;
- a compromised Tailscale account;
- TLS between machines, which Tailscale Serve or WireGuard provide.

## 1. Pairing is the boundary

Every client pairs once and gets its own **device credential**: 32 random bytes, shown
once, stored only as a SHA-256 hash. The daemon keeps them in a new `paired_devices` table:

```
id, name, kind (human | daemon | relay), secret_hash, created_at, last_seen_at,
last_seen_host, revoked_at
```

**Authentication.** Every WebSocket upgrade, on the daemon and on all three CLI front
doors, goes through one function, `authenticateUpgrade(req)`, before `upgrade()`. It
accepts any of three things:

- `Authorization: Bearer <credential>`, for native clients (iOS `URLSessionWebSocketTask`, the Bun client, the CLI, the relay, peer daemons);
- a `hyperneo_device` cookie (HttpOnly, Secure when served over HTTPS, `SameSite=Strict`, scoped to that origin), for the web UI, because browsers cannot set headers on a WebSocket;
- nothing else: never a query string, never logged.

The upgrade attaches `{deviceId, kind}` to the connection. `CallContext` carries it, and
`rpc-adapter.ts` derives the caller from it instead of hard-coding the principal:

| kind | principal | may call |
| --- | --- | --- |
| human | `local` | everything, as today |
| relay | `relay` | read subscriptions plus the operations the push relay reads: `neo.snapshot`, `neo.publication.read`, `client.list`; nothing else |
| daemon | `peer` | `operations.list` and forwarded `message.send`; never `requireLocalUser` operations |

**Pairing a new device.**
1. A **pairing code** is created only from an already trusted place:
   - the local CLI, `hyperneo pair [--kind human|relay|daemon] [--name …]`, over the `0600` session door;
   - or Settings → Devices → "Add device" on an already paired human device.

   **Allow.** A code made from the CLI is ready to use only while no device is paired yet, which is how the first device pairs. Once any device is paired, a CLI code is created *pending*. It redeems only after the human taps **Allow** on an already paired human device (`device.pair.pending` lists pending codes, never the codes themselves; `device.pair.approve` allows one). A code made in Settings on a paired human device is that device's own Allow. Until it is allowed, `POST /pair` answers `403 awaiting_approval` without counting a failure. Once a device is paired, AI sessions, which only reach the CLI path, can request a code but can't make it usable. The one exception is the bootstrap window before the first device pairs: then a CLI code needs no Allow, so on a fresh daemon an agent could pair first. The human closes that window by pairing a device before anything else. That pairing, and any agent device made in the window, shows in Settings → Devices (S6) and can be revoked. Enforcement (S8) refuses to turn on while unrecognised devices are listed.
2. The code is 10 base32 characters, single use and valid for 10 minutes. It is shown as text, plus a QR code holding `https://<host>/pair#<code>`. The `#` keeps the code out of server logs and the `Referer` header.
3. The new device posts `{code, name}` to an unauthenticated `POST /pair`. The device's kind (and so its principal) is fixed when the code is created and stored with it; `POST /pair` accepts no `kind`, so whoever redeems a relay or daemon code can never become `human`. Codes allow 5 failed attempts per daemon per minute. After 20 failures in an hour, `POST /pair` refuses everything for 15 minutes and then reopens. `hyperneo pair --reset-lockout` (over the 0600 session door) clears the lock at once, so someone on the network who floods bad codes can delay pairing but can't block it, and the first device can always pair from the machine itself.
4. On success the daemon returns the credential once:
   - in the response body, for native clients;
   - or as `Set-Cookie`, for the web.

**The first device.** It has to start from the machine itself: the human runs
`hyperneo pair` in a terminal, or the daemon prints a one-time pairing URL at first start.
No device is trusted just because it connects over loopback, because a browser page can
reach loopback too.

**Rotation and revocation.**
- Settings → Devices lists each device's name, kind, last seen time and host.
- "Revoke" sets `revoked_at` and closes that device's open sockets at once.
- "Re-pair" issues a new credential and revokes the old one.
- Credentials don't expire on a timer, but a device unseen for 90 days is flagged for review.
- `hyperneo devices revoke <id>` does the same from the terminal, for a lost phone when no paired UI is at hand.

**Where each client stores its credential.**

| Client | How it pairs | Credential stored in |
| --- | --- | --- |
| Web UI | Opens `/pair#code`, or the pairing screen shown on a `pairing_required` refusal | Cookie, per origin: localhost, MagicDNS name and LAN name each pair separately |
| iPhone (Neo iOS) | New Pair screen: scan the QR or type the code, against the saved daemon URL (Tailscale Serve HTTPS recommended, as today) | Keychain, sent as the Bearer header |
| Push relay (neo-ios `Relay/`) | `hyperneo pair --kind relay` on that Mac | A 0600 file, sent as the Bearer header |
| CLI and other local tools | `hyperneo pair` | `<dataDir>/cli-device` (0600) |
| Other machines and daemons | `daemon.attach` takes a pairing code made on the remote daemon | A new `remote_daemon_secrets` table, never returned by settings RPCs |

## 2. Origin and Host checks (browser defence, not identity)

Every HTTP request and `/ws` upgrade must pass a Host and an Origin check.

- **Host** must be one of:
  - `localhost`, `127.0.0.1` or `[::1]` (with the port);
  - a name added on purpose under Settings → Network → "Allowed hosts", such as the MagicDNS name that Tailscale Serve forwards, or a LAN name.

  This blocks DNS rebinding.
- **Origin**, when present, must be `http(s)://<allowed host>`. Anything else gets 403 before pairing is even looked at.
- **No Origin** (native clients) is accepted only together with a Bearer credential.
- **CORS:** the `*` preflight answers go away. The web UI is same-origin and doesn't need them.
- The GitHub webhook keeps its HMAC check and skips Origin, Host and pairing.

## 3. Loopback by default

- A new default bind of `127.0.0.1`, with `::1` too where the runtime supports it.
- Binding anything else takes an explicit opt-in: `--host <addr> --expose`, or Settings → Network → "Listen on" with a warning.
- Compatibility: daemons that already set `HOST`/`--host` today keep starting on that address, with a startup warning, until the human makes the Listen-on change in migration step 5. Only after that change, or for a new `--expose`, does the daemon refuse to bind a non-loopback address while pairing enforcement is off. The one exception is the address the rollback switch restores (below): the daemon starts on it with a warning, including a default-config daemon whose previous address was `0.0.0.0`.
- The phone keeps its route: `tailscale serve --https=443 http://127.0.0.1:9283`. Serve connects to loopback, so the existing `https://<machine>.ts.net` URL keeps working. Its MagicDNS name goes into Allowed hosts.
- Other machines move to `wss://<machine>.ts.net/ws` through Serve, the same way.

## 4. Migration: nothing disconnects

The changes run in order, and each step ends only on an observation the human can check
in Settings → Devices.

1. **Report mode** (ships first, refuses nothing): pairing, the device table and the upgrade check all ship in a report-only mode. Unpaired connections are still accepted, but counted per host and Origin under "Unpaired connections seen". The Origin and Host checks also only log at this step.
2. **Pair everything.**
   - The web pairs on each origin that is actually used.
   - A new iOS build ships the Pair screen; the phone pairs.
   - The relay, the CLI and each peer daemon pair.
   - Step done when Devices shows every client seen in the last 7 days as paired, and "unpaired seen" has been zero for 3 days.
3. **Move addresses while the old bind still listens.**
   - Set up Tailscale Serve to loopback on each daemon machine.
   - Point the phone and the saved daemon attachments at the Serve URLs, and add those names to Allowed hosts.
   - Step done when every device's `last_seen_host` is a Serve or loopback host.
4. **Enforce.** A human-only toggle, "Require pairing", turns on refusals and the Origin/Host checks. It also re-runs the step 2 check and refuses to switch on if any client seen recently is still unpaired.
5. **Loopback.** Only now does the live daemon move to the new default bind, and only when the human flips it.

**What old clients see after step 4.**
- The `/ws` upgrade gets HTTP 401 with `{error: 'pairing_required', pair: '/pair'}`.
- The web bundle ships with the daemon, so it is never old: it shows the pairing screen.
- An old iOS build shows its existing "can't connect" error. That is why the new build has to be on the phone before step 4.
- An unpaired peer daemon: attach and probe fail with `pairing_required` in Remote Daemons settings.

## 5. Tests

Synthetic, isolated daemons only:
- NODE_ENV=test, with their own data dir, database and port;
- never 8399, never a provider key;
- no unattended GUI tests.

Built on `tests/helpers/daemon-server.ts` (spawned daemon on port 0) and `standalone-server.ts`. The cases:
- An unpaired upgrade is refused in enforce mode and counted in report mode, on the daemon and on each CLI front door: prod, dev and embedded.
- A pairing code works once, expires after 10 minutes, and locks out after too many failed attempts.
- The cookie and the Bearer header both authenticate. A revoked device's open socket closes within one second.
- A cross-site Origin gets 403. An unknown Host (DNS rebinding) gets 403. A native client with no Origin but with a Bearer credential is accepted.
- `relay` and `peer` principals are refused by `requireLocalUser` and `human_only` operations, except the relay's three reads (`neo.snapshot`, `neo.publication.read`, `client.list`), which are admitted by name. A peer's forwarded `message.send` still works.
- The default bind is loopback. A non-loopback bind without `--expose` refuses to start.
- The session door socket is never world-accessible, including the moment between `listen` and `chmod`.
- Verify journey: `pair-device.sh` on an isolated daemon pairs a CLI device and a web cookie, opens `/ws` with each, revokes one, and checks the refusal.
- iOS: unit tests in neo-ios for Keychain storage and the Bearer header. The Neo iOS session checks the on-device flow by hand.

## 6. Slices (daemon repo; each is a small PR from dev)

| # | Slice | Prod lines |
| --- | --- | --- |
| S1 | `paired_devices` table, hashing, pairing-code operations (including the pending/Allow state and the first-device rule), `POST /pair` with its limits | ~450 (measured; size limit waived) |
| S2 | `authenticateUpgrade`, shared by `app.ts` and the three CLI front doors; report mode only | ~150 |
| S3 | Caller principal from the device kind (`local`/`relay`/`peer`); gate updates, including `device.pair.approve` requiring a paired human device | ~150 |
| S4 | Web pairing screen and cookie | ~200 |
| S5 | `hyperneo pair` / `devices revoke`; `daemon.attach` with a pairing code and the secret table | ~150 |
| S6 | Settings → Devices (list, revoke, re-pair, unpaired-connections report) and the **Allow** prompt for pending codes, on the web and in Neo iOS | ~200 |
| S7 | Origin/Host allowlist and Allowed hosts setting; drop CORS `*` (logging only until S8) | ~100 |
| iOS | **lsm/neo-ios, not this repo:** the Pair screen, Keychain storage and the Bearer header on every `/ws` upgrade, plus the relay's Bearer header. It must be merged **and installed on the human's phone** before S8 or S9 lands | — |
| S8 | "Require pairing" enforce toggle with the step 2 check, plus the rollback switch below | ~60 |
| S9 | Loopback default bind, `--expose` and the Listen-on setting; the rollback switch also restores the previous listen address | ~80 |
| S10 | Session door: create the socket with a 0077 umask so it is never wider than 0600 | ~20 |

The iOS row can start now: S1 already serves `POST /pair`, and from S2 on the daemon reads the Bearer header without refusing anything.

Order: S1 → S2 → S3 → S5 → S4 → S6 → S7 → S10, then migration steps 2 (the iOS build on the phone) and 3, then S8
(step 4), then S9 (step 5).

**Hold on enforcement.** The laptop daemon deploys automatically when a PR merges, and the
human is often away from it with only the phone. So no slice that refuses connections, enforces
Origin/Host, or binds to loopback by default (S8, S9, and any S7 change beyond logging) may
merge until Neo confirms that the iOS pairing build is merged and installed on the phone. After
that, S8 and S9 each still wait for the human's go.

**Rollback switch.** S8 ships one documented step that turns enforcement off without the
phone: `hyperneo security enforce off`. It calls a new operation, `device.enforce.off`, over the
local session door, a Unix socket that pairing never gates, so it works from any shell on that
Mac. The door runs only its allowlist and stamps callers `principal: 'session-door'`, which
`isLocalUser` refuses, so S8 adds `device.enforce.off` to `DOOR_OPERATIONS` and lets it accept
door callers, the same `fromDoor` exception `device.pair.reset_lockout` has. The exception only
turns enforcement off; turning it on stays human-only in Settings. Agent sessions are handed the
door too, so an agent on that Mac could turn enforcement off. That widens nothing: they already
run as the human's user with a shell. Each switch-off is logged and shown in Settings → Devices. From another
machine the human reaches it over SSH on the tailnet:
`ssh <user>@<mac>.<tailnet>.ts.net hyperneo security enforce off`. After S9 the same command also
puts the listen address back to what it was before the Listen-on change. That restored address
is treated like the compatibility case in section 3, not as a new non-loopback bind: the daemon
starts on it with a startup warning instead of refusing it while enforcement is off. Turning
enforcement and loopback back on is again the human's Settings change. Before S8 merges, the
human checks once, from another machine, that this SSH route works (Remote Login or Tailscale
SSH enabled on the Mac).
