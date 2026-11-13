## Kimi K2.8 preview catalogue and default effort

Run `kimi-k2-8-preview.ts` through `proof-run.sh` with the pinned Bun and the
checkout head. It owns a fresh test HOME, database and daemon on a random
loopback port, points the Kimi provider at its own local mock of the Kimi
Anthropic endpoint, and saves no keys. No real Kimi account is contacted.

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/kimi-k2-8-preview.ts "$(git rev-parse HEAD)"
```

Register the Kimi provider over RPC with the mock origin and a synthetic key,
then read `models.list`. The `kimi-for-coding` entry must report the K2.8
Preview name, a 1,000,000-token context window, granular thinking and exactly
the `low`, `high` and `max` effort levels. The K3 and K3.1 entries stay as they
were.

Create a session on `kimi-for-coding` with no thinking level chosen and send one
message. The daemon must build adaptive thinking and ask for `high` effort, and
the first real turn that reaches the mock endpoint must carry
`output_config.effort: "high"` with model `kimi-for-coding`. The synthetic
credential probe with a `.` prompt does not count as a turn.

Close the mock, hub transport and daemon; retain `kimi-k2-8-preview.json` with
`passed` and `resourcesClosed`, require wrapper exit 0 and remove temporary data.
The web model label and the K3.1 behaviour stay outside this proof.
