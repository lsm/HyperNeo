# Exact worker final lines become visible todo blockers

Use the shared metadata-only setup and cleanup in SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/worker-blocker-lines.ts verify
```

The helper owns an ephemeral daemon, disposable manual sessions, and refusing
GitHub stub. Synthetic SDK input/results go through the production writers.
The real work.status adapter and Neo refresh must turn an exact final
`Blocked (needs_human): reason` line into a needs-human todo and open reply
card. An exact environment line becomes an environment blocker without a
human card. A marker before a different last line keeps ordinary behavior.
Read the resulting public snapshot, answer its synthetic human card through the public RPC, and verify delivery to the assigned worker without reopening the card on report replay. Retain blocker-lines.json and proof.log.
No model reasoning or GUI rendering is claimed. All owned resources close in finally.
