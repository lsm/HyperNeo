# Exact worker final lines become visible todo blockers

Use the shared metadata-only setup and cleanup in SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/worker-blocker-lines.ts verify
```

The helper owns an ephemeral daemon, disposable manual sessions, and refusing
GitHub stub. Synthetic SDK input/results go through the production writers.
The real work.status adapter and Neo refresh must turn an exact final
`Blocked (needs_human): reason` line into a needs-human todo and a wake for Neo containing the blocker and todo ID,
without an immediate human card. If Neo can answer, it must reply to the worker;
otherwise it must ask a linked yesno/choice question with options. After an untouched
60 minutes with no linked open question, the fallback creates the original reply card. An exact environment line becomes an environment blocker without a
human card. A marker before a different last line keeps ordinary behavior.
Read the resulting public snapshot, advance the fixture clock to the fallback deadline, answer its synthetic human card through the public RPC, and verify delivery to the assigned worker without reopening the card on report replay. Retain blocker-lines.json and proof.log.
No model reasoning or GUI rendering is claimed. All owned resources close in finally.
