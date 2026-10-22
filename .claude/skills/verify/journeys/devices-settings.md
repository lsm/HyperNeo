## Settings > Devices manages issued codes and explicit removal

Read SKILL.md. No unattended GUI tests. Use the non-GUI real-daemon/actual-pairing-
component proof in `web-pairing.md` for approval and authority. Its fresh synthetic
HOME/data/DB, ephemeral port and finally cleanup apply; no real credentials or
live daemon. Settings component contracts cover the small UI changes below.

For an attended Settings run only, build the web bundle and run the existing
`devices-settings.sh <free-non-8399-port>` with the human present. The helper owns
its isolated test daemon and closes it after the attended browser capture:

- At 1280 and 390, a paired browser sees **Codes waiting for Allow**: issued codes,
  not verified device identities. Only allow a code the human requested. Refresh
  devices and returning focus/online re-read the list; a code's existing expiresAt
  supplies its countdown and expired/Allow-disabled state. Offline initial load
  explains that a connection is needed.
- Allow removes a code from pending; a waiting PairPage finishes automatically.
  An unpaired browser sees the Pair this browser link, with no Allow controls.
- Devices explains that pairing is report-only: revocation closes paired sockets
  but unpaired access is still permitted. This work does not enable S8/S9.
- There is no Re-pair shortcut. Explicit Revoke → Confirm removes the selected
  old device; then Make pairing code creates the replacement. The browser itself
  still has no self-removal control in this slice. History remains visible.
- Allowed hosts and unpaired/Origin reports retain their existing behavior.

The attended helper now captures explicit removal followed by replacement-code
creation (`devices-replacement-1280.png`), masking the code. Keep captures and safe
RPC evidence in the run's evidence directory. Headless helper edits alone are
not an attended pass. Real-browser visuals, self-removal and native iOS management
remain unverified until their own attended journey; iOS is a separate ask.
