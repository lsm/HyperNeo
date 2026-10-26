# Per-session auto-compaction percentage

Neo's preference writes the ordinary `SessionConfig.autoCompactPercent` setting.
Every session resolves that setting through the same model metadata and context
budget calculation. An absent setting keeps the provider default. Busy sessions
persist the pending value and apply it through the ordinary query lifecycle at
idle; there is no Neo prefix check or special query restart.

Run the repeatable RPC proof and focused contracts from the worktree root:

```bash
bash .claude/skills/verify/neo-auto-compact-check.sh /tmp/hyperneo-compaction-fresh
```

Use a fresh absolute run directory. The wrapper starts from `env -i`,
`NODE_ENV=test`, its own HOME/data/DB and GitHub stub. The proof owns an ephemeral
loopback daemon, uses synthetic model metadata and makes no provider requests.
Its resources close in finally. No live daemon, credentials or real DB are used.

The RPC proof checks that Neo's preference and an ordinary session's setting
both defer a busy-session change until idle. With a 1M model and 70%, each has a
700K context budget and the same SDK window adjustment; no compaction is forced
at 699,999 tokens, and the threshold triggers at 700K. An ordinary session with
no override retains its default. Neo preferences still clamp 1 to 10 and 101 to
100, reject non-integers, preserve the setting across reopening, and expose the
same preference/snapshot API used by the Settings page in #8121.

The proof also checks that a percentage never crosses models (#9027): saving a
preference whose new primary has no entry while the session is busy keeps the
running model's own percentage until the switch lands, and once it lands the
session takes the new model's entry — its metadata default when the entry has no
percentage — with no pending value left behind. The per-model entry lookup
itself (a model not in the preference list gets the model default, never the
primary's percentage) is covered by the unit contracts in
`tests/unit/1-core/operations/neo-model-preference.test.ts`.

Read `evidence/observed.json` and `evidence/rpc.log` for the actual RPC results,
and `evidence/unit.log` for the contracts. This proof checks the daemon boundary;
it does not claim a browser rendering check. Rerun the separate
[ordinary restart delivery journey](spent-admission-restart.md) after changing
session lifecycle behavior: both Neo and an ordinary session must preserve an
interrupted mid-turn human input and deliver four queued markers to the model
after one restart with no extra send or restart.

For mid-turn behavior, run the [SDK auto-compaction journey](sdk-auto-compaction.md).
The SDK compacts without the retired daemon interrupt/requeue budget check; this
percentage journey checks settings and idle deferral only.
