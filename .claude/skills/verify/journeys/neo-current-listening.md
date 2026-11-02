# Current listening facts at Neo delivery

Use SKILL.md's isolated proof-run.sh setup and resource guard:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/neo-listening-delivery.ts
```

The helper owns an ephemeral daemon and scripted loopback model, a fresh HOME,
data directory and synthetic provider key. It disables external MCP servers and
stops its transports, native SDK session and servers in finally. No real voice,
account, credentials, human application or port 8399 is used.

Observe the actual native SDK model requests in observed.json: typing carries
listening:no; switching on during a held typed turn injects listening:yes;
leaving during a held live-voice turn injects listening:no; immediate worker
reports and scheduled wakes carry yes without a human acknowledgment instruction.
Idle toggles create no model request, and retrying an accepted human input does
not replay it. The model response is scripted: this proves delivery, not model
speech reasoning or audio playback. The SDK sandbox is disabled only in this
owned fixture; OS sandbox enforcement is not exercised.

Busy changes reuse immediate mailbox injection. They can land after the active
turn ends; the publication-spoken journey covers publish-time races without a
strict same-turn runner guarantee. Human input asks for an acknowledgment before
time-consuming work; a quick answer uses one publication with spoken instead.
Unit regressions also cover last-enabled-client ownership,
disconnect, no speech history replay and preserving ordinary session inputs.
