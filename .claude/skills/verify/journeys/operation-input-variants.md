## Common operation input variants

Run the metadata-only proof using the shared setup in SKILL.md:

```bash
TMPDIR=/absolute/writable/temp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/operation-input-variants.ts
```

The helper owns an isolated daemon on an ephemeral port, with a synthetic database and
no provider or model. Its real MCP invoke adapter replays sanitized refused
inputs: question lookup with id instead of questionId, and coding write planning
with targets instead of candidates. Both must match the canonical input reply.
Numeric question IDs and numeric-string work search limits must likewise match
their canonical string ID and numeric limit calls.
Conflicting aliases, malformed repository names and empty candidate arrays must
still fail validation. observed.json retains the actual replies; the shared
wrapper saves evidence and deletes disposable daemon data.

The question alias fixture comes from failed operation tool results in the
seven-day guard review; the coding alias was supplied by Neo from a real call.
All identifiers, repository names and model values are synthetic replacements.
Unit tests additionally exercise nested numeric variants and validity constraints.
This journey does not exercise a browser or a real model turn.
