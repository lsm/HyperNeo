# GitHub reads through the coding skill

Use the pinned Bun and the shared isolated setup in SKILL.md:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/retired-github-read.ts
```

The helper starts a test daemon on an ephemeral port with a disposable HOME/DB
and a refusing GitHub stub. With coding enabled and disabled, the retired read
must be absent from the real registry, MCP schema lookup and prefix discovery.
Its invocation returns unknown_operation. Write planning remains registered.

The skill's replacement path runs Bash plus gh for one PR, one issue and a
bounded recent-activity list. The fixture returns synthetic references and records
exactly three reads. No provider, real GitHub or human credentials are used.
The wrapper retains observed.json, gh.jsonl, proof.log and run-status.json, then
stops the daemon and deletes its temporary data. Historical captured evidence
remains unchanged. Direct ledger unit coverage remains in the ref, work and query
ledger suites. Operation-only RPC journeys were retired with their entry point.
