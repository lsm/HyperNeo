# Root Neo refreshes its stored prompt and tools at startup

Run from the worktree root. Synthetic fixtures only: fresh HOME/data/DB, NODE_ENV=test,
no real keys or credential reads, loopback scripted model and ephemeral non-8399 daemon port.
This is the existing real-SDK publication journey extended to cover an old stored root.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/neo-unsandboxed-sdk.sh /absolute/fresh/evidence-directory
```

The test first creates a real SDK transcript containing a random marker at a synthetic
`.coordinators/old-root` cwd. It seeds only its own DB with an existing root whose prompt
is obsolete and sdkToolsPreset is empty, retaining that SDK id and origin path, then boots
the actual daemon at the ordinary Neo cwd. No live session, transcript or DB is inspected.

Through session.get and Neo message/publication RPC, verify the stored and model-received
prompt is neoPrompt(packBriefs), native Read/Bash tools are present, the prior marker still
reaches the model, SDK session identity is unchanged, the shared lifecycle copied the
transcript to the new cwd, and the human-visible publication is readable. The resumed fixture uses dontAsk with
Read/Grep/Glob/web/Bash approved and native mutation tools unavailable. The scripted reply proves transport/config/publication
plumbing; it is not evidence of a real model's spontaneous decision to publish.
Missing transcript data cannot be reconstructed by this
config refresh and is not claimed recovered.

The wrapper saves `neo-goal-cycle-sdk.json` outside the worktree and removes
its fresh HOME/data/temp directory on success or failure; it contains startup
config, tools seen by the model, historySeen, both paths, SDK id, publication and web-reader
receipt. The test closes SDK turns, WebSocket, daemon and mock in finally. Focused startup
unit tests also cover new/existing roots, no-root recovery, idempotency, changing pack
briefings and preservation of ordinary settings/history. Run bun run check before review.

After manual squash under the saved repository merge rule (eligible bot approval on the
exact head plus green CI), record hyperneo build. The coordinator then checks the laptop's
stored root config read-only: current prompt including root-turn-end and goal-cycle,
Read/Bash in sdkToolsPreset and publication invoke in allowedTools. Do not deploy/restart
or edit the live DB from this journey. Keep rollout/live-config confirmation pending until
those actual readbacks exist.

The sandbox-update RPC must report success with sandboxEnabled false and no
error property. JSON omits undefined properties: an expected `error: undefined`
key incorrectly rejects that successful wire response. This journey exercises
both synthetic credential sources through the real SDK, not an OS sandbox.
