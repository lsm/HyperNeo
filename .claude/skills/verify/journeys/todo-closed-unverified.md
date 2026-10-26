# Closing without a passed outcome check

Use the shared metadata-only isolated daemon setup in SKILL.md. This helper
owns an ephemeral daemon, uses only synthetic data, disables external HTTP,
and needs no model or provider.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-closed-unverified.ts verify
```

The agent MCP door opens a coding todo without a passed PR check and closes it
successfully. The public ask read must say `Closed unverified`, carry
`state: closed_unverified`, and exclude it from the Done count before and after
restarting the isolated daemon. Evidence is `observed.json` and `proof.log`.
The wrapper removes synthetic daemon data after preserving evidence.
Both neo.ask.read and neo.snapshot must expose the same label and state.

For web proof, first build packages/web, then pass `--web` after `verify` in the
command above. Read the disposable run's evidence/ready.json while the helper
waits. Open that port's /neo page and inspect the Unverified delivery row: it
must say Closed unverified and use a warning question mark, never a done tick.
Create the run's release file to finish; the helper also times out after five
minutes. Save screenshots outside disposable data before releasing it.
Native iOS rendering is not covered; its client must accept this new state.
