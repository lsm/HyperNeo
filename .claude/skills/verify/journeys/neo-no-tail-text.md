# Short delivery reminders without duplicating a Neo reply

Use shared isolation and resource checks from SKILL.md. From the checkout root:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/neo-no-tail-text.ts verify
```

The helper uses the installed real Claude Agent SDK and runtime, a loopback scripted
model on ephemeral ports, real operation admission/MCP serialization, a synthetic
database and a connected synthetic speech client. It saves `observed.json`, the
SDK diagnostics and the proof log, then removes its isolated HOME/data. No provider
credentials, live daemon, audio device, browser or deployment is used.

Speech submission and durable publication must succeed. Their model-visible results
must contain one short reminder to add no assistant text this turn except a requested
transcript/record or the required summary on scheduled goal wakes. A discovery
operation must have no delivery reminder. The explicit transcript scenario must
still be able to return assistant text. The scheduled-wake scenario sends the actual
goal-cycle/root-turn-end prompts and requires the SDK's final result to retain the
single summary line used to label a wake row; it does not run the full scheduler UI.
Focused operation tests cover retries, rejected publications, and failed/cancelled
speech; these must not falsely claim a delivery.

The diagnostic scenarios deliberately end with empty assistant text. Claude Code
2.1.302 injects its own `Your previous response had no visible output` meta-message
even after successful speech/publication. The helper records that remaining external
behavior instead of claiming the reminder disables it. A control adds the runtime's
`claude/endTurn` metadata and proves that it ends immediately after speech, without
allowing the next model request. The tool-name environment exemption would cover
every operation behind shared `invoke`; neither control is a selective nudge-only
exemption. Do not enable either globally for Neo or unrelated tools in this journey.

This proves actual SDK tool-result delivery and the external runtime behavior. The
model is scripted: it does not establish how a real model follows the reminder, nor
does speech submission establish audible playback. Merging is the stopping point;
deployments remain paused.
