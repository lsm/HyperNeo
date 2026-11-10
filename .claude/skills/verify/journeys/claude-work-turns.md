# Claude turns through work.turns

Use the shared metadata-only isolated daemon setup in SKILL.md. The helper writes
a synthetic transcript under its disposable HOME and needs no model or provider.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/claude-work-turns.ts
```

The real `work.turns` operation reads a Claude Code session and returns one turn.
A message queued during the turn is an input by its receipt id, a compaction
summary neither ends the turn nor counts as an input, a final message split over
two rows ends at the last row, and URLs come from tool output and the final
message. The returned cursor reads nothing more. Evidence is `observed.json` and
`proof.log`.
