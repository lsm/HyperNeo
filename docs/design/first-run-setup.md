# First run: set up or connect, not "pair"

Status: proposal, 2026-11-16. Design only. Paths without a prefix are under `packages/`.

## Why

The first screen of a new HyperNeo, in a browser or in the desktop app, is "Pair this
browser: enter the code from hyperneo pair or from a paired device"
(`web/src/components/pairing/PairPage.tsx`). The web app shows it whenever `/ws` answers
401 (`web/src/client.tsx`), and every browser needs a paired-device cookie or bearer token
to pass (`daemon/src/lib/pairing/upgrade-auth.ts`). There is no exception for a new,
empty daemon: the first code can only be made by the local CLI (`device.pair.create`,
`daemon/src/lib/pairing/pairing-operations.ts`).

So a new user must find a terminal, run `hyperneo pair`, and type a code into a page that
talks about pairing before they have anything to pair with. The desktop app is worse: it
starts or attaches to a daemon and loads the same web page (`desktop/README.md`), and never
pairs its own window, so its user also needs the terminal.

Pairing makes sense later: a second browser, a phone, or a desktop app joining a HyperNeo
that already has an owner. It is the wrong first step.

## How others do it

- Jupyter prints a link with a one-time token when the server starts; opening it signs the
  browser in.
- Home Assistant opens an onboarding wizard on a new instance (owner, name, basics). Its
  phone app first asks which server (found on the network or typed), then signs in.
- Self-hosted web apps such as Open WebUI let the first visitor set up the owner; later
  users need the owner's approval.

The shared pattern: the first owner proves they own the machine with something only the
machine gives them, then a short setup. Joining a server that already has an owner is a
separate choice, and that is where a code and an approval belong.

## The design

**1. A setup link instead of the first code.** While the first-device window of
`pairing-v2-approval.md` is open (no human phone has ever paired, or a lost-phone reset from
`hyperneo devices reset-human` is open), the daemon makes a one-time setup token when it
starts. Minting and redeeming both check that same window, so after a reset and a restart
the daemon prints a new setup link. It writes the token to `<data-dir>/setup-token` as an owner-only file, checked the way `daemon/src/lib/pairing/local-credential.ts` checks the local credential (no group or other permission bits and the owner uid on POSIX, file ACLs through `checkWindowsCredential` on Windows),
and prints `Open <url>/setup#<token>` on the terminal that started it, where `<url>` is the dialable address `runtime.json` already advertises (`dialableHost` in `daemon/src/lib/runtime-descriptor.ts`: the bound host, with a wildcard bind shown as `127.0.0.1`).
The daemon log records only that a setup link exists. Opening the link grants the browser
the first human device, the same grant as a first-device pairing today. The token stops
working when the window closes: the next human pairing closes it and consumes an open
reset. It is not loopback trust: a tailnet proxy makes
remote requests look local, so the address alone proves nothing. `runtime.json` is not
used for the token because it is world-readable.

**2. The desktop app needs no typing.** The desktop shell already finds the daemon through
`<data-dir>/runtime.json` (`desktop/src-tauri/src/lib.rs`). When the daemon reports that no
human has paired, the shell reads `setup-token` and opens its window at the setup link. The
desktop window becomes the first device.

**3. A short setup, first device only.** After the link, the web app shows a few steps,
each skippable: name this device; sign in to a model provider (the existing Claude and
OpenAI sign-ins); pair a phone (the existing QR flow); then Neo.

**4. The desktop app asks one question on first launch.** With no local HyperNeo data it
asks: "Run HyperNeo on this computer" (start the bundled daemon, then step 2) or "Connect to
a HyperNeo on another computer". Connecting is today's later-device pairing, started from
the paired side, in the existing flow in `web/src/components/settings/PairPhoneFlow.tsx`.
On a device already paired with that server, the owner makes one of two things, and the
desktop app follows that thing's existing path:

- Over HTTPS, a v2 ticket link (from `/pair2/request` as a signed-in human). The app binds
  with the ticket (`/pair2/bind`), waits for the owner's Allow, then completes.
- Otherwise, a pairing code (from `device.pair.create`). The app redeems it with `POST /pair`
  under the code's existing approval state. A code made by a paired human is already
  allowed, so no second Allow follows.

An address alone cannot
start pairing, because `/pair2/request` admits only a paired human
(`daemon/src/lib/pairing/pair2-route.ts`). The app remembers each server it has joined and
switches between them from its menu.

**5. Pairing stays for joining.** A browser that reaches a daemon that already has an owner
still sees the pairing page, worded for that case: "This HyperNeo already has an owner. Ask
them to allow this browser."

## What does not change

Later-device pairing, phone QR pairing, approval, revocation and the lost-phone reset. The
CLI's `hyperneo pair` still works for the first device.

## Change plan

Each slice is one PR from `dev` (the repository's default and target branch), about 100 to
200 production lines, failing tests first.

1. **Daemon: the setup token.** Make, store, print and redeem it inside the first-device
   window; `/setup` route.
2. **Web: the setup steps** and the `client.tsx` routing; the pairing page's new wording.
3. **Desktop: open the setup link** for a daemon with no paired human.
4. **Desktop: run here or connect,** and the list of joined servers.

`bun run system-map impact`: `upgrade-auth.ts` has 14 importers and sits two imports from
the pairing tables (`paired_devices`, `pairing_codes`, `pairing_requests` and others); slice
1 adds a grant path and does not change those importers. `runtime-descriptor.ts` has 3
importers (CLI, daemon, pairing) and is unchanged; the token gets its own file.
`client.tsx` is the web entry and has no importers.

Acceptance, one integration case per row:

| Case | Expected |
|---|---|
| New daemon started from a terminal | prints a setup link; opening it lands on the setup steps, not the pairing page |
| The same link after a human device has paired | refused; the pairing page with the "already has an owner" wording |
| `hyperneo devices reset-human`, then a restart | a new setup link is printed and grants the first device |
| New desktop install | the window opens the setup steps with no code typed |
| `setup-token` file, on POSIX and on Windows | readable only by its owner |
| Desktop "Connect to another computer" with a v2 ticket link made on the other server's paired device | binds, waits for that owner's Allow, completes, then lists that server |
| The same with a pairing code made on that paired device | redeems it with `POST /pair` with no further Allow, then lists that server |
| The same with only the server's address | no pairing starts; the app asks for a link or code from a paired device |
| Second browser on a daemon with an owner | pairing page, as today |

## Out of scope

Accounts and passwords, and discovering servers outside the tailnet.
