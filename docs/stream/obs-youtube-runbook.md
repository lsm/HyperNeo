# NeoKai Live UI Demo — OBS/YouTube Runbook

Goal: run a bounded, safe YouTube stream that walks through NeoKai using the dev-NeoKai Space.

## Pre-stream checklist

- [ ] Stream key set in OBS but **Start Streaming** not clicked.
- [ ] Scene collection loaded: `NeoKai-Demo`.
- [ ] Browser source for NeoKai UI sized to 1440x900 (or 1920x1080 with centered window capture).
- [ ] Webcam/mic tested; mute toggle mapped to a hotkey.
- [ ] Chat moderation: YouTube live chat visible on a second screen; slow mode enabled.
- [ ] `make dev DB_PATH=/tmp/beokai-8383 PORT=8383` running and reachable.
- [ ] If using the dev proxy: start the server with `NEOKAI_USE_DEV_PROXY=1 make dev DB_PATH=/tmp/beokai-8383 PORT=8383`.
- [ ] Demo dry-run executed within the last hour; no new breakages.
- [ ] Dev proxy active or a low-cost model selected so API calls do not burn credits.
- [ ] No credentials, `.env`, or Keychain visible on screen.

## Scene collection

| Scene | Purpose | Source layout |
|---|---|---|
| `Starting Soon` | Hold while viewers join | Branded slate + soft music, no UI |
| `Demo Main` | Primary walkthrough | NeoKai window capture + small facecam |
| `BRB / Fail-Safe` | Covers crashes, PII leaks, or unrecoverable demo breakage | Branded slate + "Be right back" + mute mic |
| `Ending` | Outro and CTA | Branded slate + links |

### Fail-safe scene trigger conditions

Switch to `BRB / Fail-Safe` **immediately** if any of the following occur:

1. Real credentials, API keys, or personal workspace paths appear on screen.
2. The UI enters an unplanned destructive flow (merge dialog, delete confirmation, branch deletion).
3. The app crashes or the WebSocket disconnects and does not recover within 30 seconds.
4. A viewer posts harmful instructions in chat that could be copied into the demo.
5. You lose audio or the host becomes unable to narrate safely.

Hotkey: bind `F12` to **Switch to Scene: BRB / Fail-Safe** in OBS.

## YouTube setup

1. YouTube Studio → Go live → Stream (copy stream key).
2. OBS → Settings → Stream → YouTube - RTMPS → paste key.
3. Set stream title: `NeoKai self-coding demo — multi-agent chat & Spaces`.
4. Set category: `Science & Technology`.
5. Visibility: Public only after the dry-run passes. Unlisted first if testing.

## Safety rules during stream

- Use the isolated `DB_PATH=/tmp/beokai-8383` database only.
- Workspace path must be under `/tmp/neokai-demo-workspace`.
- No merges, no pushes, no deletes of spaces/tasks/sessions.
- No real provider calls unless dev proxy is running.
- Keep the CLI/terminal with credentials off-screen.
- End the stream from the `Ending` scene; do not abruptly kill OBS.

## Post-stream

1. Click **Stop Streaming** in OBS, then **Stop Recording** if local backup was enabled.
2. Export the VOD from YouTube Studio for review.
3. Append observations (breakages, viewer questions, timing notes) to `docs/stream/dry-run-report.md`.
4. Copy Forge evidence into the dev-NeoKai Space as a mission artifact.
