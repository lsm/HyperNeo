## Settings > Devices lists devices, unpaired connections and codes waiting for Allow (S6 of docs/design/daemon-security.md)

Build the web bundle first (`cd packages/web && bun run build`), then run on a free
port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/devices-settings.sh 9320
```

The script starts an isolated daemon through the CLI front door (`env -i`,
NODE_ENV=test, its own HOME, data dir and database, no provider key). It records one
unpaired connection from a foreign Origin, then drives headless Chromium with
`devices-settings-view.mjs`: a desk browser pairs at `/pair#<code>`, the CLI makes a
relay code (pending, since a device is now paired), and the browser opens
`/settings?tab=devices`. Codes and credentials stay in variables; the screenshot that
shows a live code masks it.

End state, in `$RUN/evidence/`:
- `devices-1280.png`: "Waiting for Allow" lists `Push relay` with an Allow button; the
  desk browser is marked `This browser` with no Revoke or Re-pair; "Unpaired
  connections seen" shows `https://evil.example` with `No credential · 1 time`.
- Allow answers `No codes are waiting for Allow.`, and the relay then pairs (200).
- `devices-390.png`: the same lists at phone width, the relay with Re-pair and Revoke.
- `devices-repaired-1280.png`: Re-pair on the relay shows a new code with `Enter this
  code on the push relay.` and the old relay `Revoked`.
- `devices-unpaired-390.png`: a second, unpaired browser sees `Pair this browser to
  manage devices.` and a `Pair this browser` link.
- The pairing code appears 0 times in the daemon log.
