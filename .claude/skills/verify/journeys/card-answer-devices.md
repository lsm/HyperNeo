# Card answers require a human device

Run the isolated daemon and exercise the CLI, session door and human RPC:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/card-answer-devices.ts
```

The relay command reports an unknown option and a session-door answer is refused. The
card stays open until the human RPC answers it. The evidence records the command,
door response, RPC response and resulting card.
