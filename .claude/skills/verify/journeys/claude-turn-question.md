# Claude turn-ended question reaches work.status

Use the shared metadata-only isolated daemon setup in SKILL.md. The helper writes
a synthetic Desktop record and transcript under its disposable HOME and needs no
model or provider.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/claude-turn-question.ts
```

The real `work.status` reads an idle Claude Desktop session whose turn ended on a
`wrap_up` question and returns `needs_you`, the question as `waitingFor` and its
button labels. `work.find` stays `done` because it reads no transcript. After a
human reply is written to the transcript, `work.status` no longer reports the
question. Evidence is `observed.json` and `proof.log`.
