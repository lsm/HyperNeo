# Neo speaks independently of screen publications

Use shared resource/isolation setup in SKILL.md and run:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/new/evidence \
  .claude/skills/verify/spoken-replies.ts verify
```

This boots the production daemon with an empty temporary HOME/database, no
provider credentials and external HTTP refused. Two real WebSocket clients call
the operation door; Neo speaks through the real MCP adapter. Require delivery to
only the opted-in client, stable-request retry deduplication, foreign-client ack
refusal, separately saved playing/played states, cancellation on disconnect,
no reconnect replay and zero extra publications. All writes use the real writer
worker. Inspect spoken-replies.json and the wrapper's exit status.

`serve` mode is the companion native Simulator fixture: ports18554/18555, public
synthetic PCM, no model or microphone. The iOS spoken-replies journey owns it and
drives actual drawer controls and playback; protocol proof alone does not prove
the phone speaker, rendered UI, a real model's wording or native audio routes.
