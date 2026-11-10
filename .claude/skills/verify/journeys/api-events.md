# Phone-used push payload contracts

Use SKILL.md's resource guard and metadata-only proof wrapper. This helper owns
an ephemeral daemon and local audio/ASR listeners, all on port 0. No browser,
provider credentials, model, simulator or physical phone is required.

```sh
bun run test:api-events
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/api-events.ts
bun run api:surface
bun run check:api-surface
```

Require all seven pinned phone event subscriptions over a real WebSocket:
message snapshot/delta from `messages.bySession` and a synthetic repository write;
settings RPC/session projection pushes; the Neo service notification; speech
listen/say through RPC/MCP, including actual local audio/end/failure frames; and
voice-stream RPCs relaying a local ASR transcript. Every received payload must
validate against its source-owned Zod schema, and all five speech variants must
arrive. The virtual session projection exercises the supported null-session case;
contract tests cover populated processing/question shapes. Neither proves every
runtime state transition or query-specific row model.

Check stable export bytes, refusal of missing phone schemas, and payload drift
with the existing snapshot drift gate. Event enum/field changes must use result
compatibility rules. First-time payload coverage must be labelled coverage-only,
excluded from phone compatibility totals, and never applied to an old tag whose
source has no schemas. Reuse the API release-compatibility journey for historical
collection; retain its source hashes and explicitly untyped historical counts.

Save api-events.json and proof.log before the wrapper deletes temporary data.
After the daemon-owned merge, repeat against the containing build, deploy by the
owner route and confirm the served commit before repeating from that checkout.
Synthetic listeners prove transport and schema agreement, not a physical phone's
playback or a production audio backend's health.
