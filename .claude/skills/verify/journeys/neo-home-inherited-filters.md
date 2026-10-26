# Home Git filter isolation

Read shared SKILL.md setup first. Use a fresh isolated daemon and its owned HOME,
data directory and synthetic Git identity. No provider or model turn is needed.

After Launch, run:

```bash
bun .claude/skills/verify/neo-home-save.ts <port> "$RUN" inherited-filters
```

The helper commits a synthetic attributes policy, configures a local bare origin
and peer, then installs clean, smudge and process filter commands in the isolated
HOME's Git configuration. Each command would write a marker outside Neo's home;
the process command also fails its protocol handshake. Required filters are set
to true so disabling them must not jam a save or read.

Save must publish exact unfiltered bytes. Read must fetch peer progress and
return the exact file without running a filter during worktree creation, rebase
or merge. Inspect `evidence/neo-home-inherited-filters.json`: every result must be
successful, `executed` must be null and actual bytes must match expected bytes.
The helper restores its synthetic configuration in finally. Stop the owned
daemon and preserve evidence before removing its run, using shared setup.

Focused operation contracts also exercise system Git configuration. This journey
is daemon/RPC filter proof; it makes no claim about native SDK sandbox enforcement.
