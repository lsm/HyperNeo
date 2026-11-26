### Coding PR notices while CI runs

Run the isolated daemon proof from the repository root:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/coding-ci-notices.ts verify
```

Use `reproduce` on the reproduction commit. The production coding-pack sweep reads
a synthetic pending PR and routes its notices to an isolated worker mailbox. The
baseline sends two CI reminders. The fixed run sends none and escalates to Neo at
60 minutes. The evidence records the observed state, notices and mailbox count.
The proof uses no live GitHub calls or provider turns; it does not prove model
consumption of the mailbox.
