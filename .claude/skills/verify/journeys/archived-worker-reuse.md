# Coding dispatch skips archived Claude Desktop workers

Run the isolated proof with the shared setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/archived-worker-reuse.ts
```

The helper boots an isolated daemon and runs the todo start path with synthetic
Claude Desktop records. The real status mapping and coding worker selection
run against the daemon DB. Native starts and sends are fixture effects.

Require `PASS mixed=idle archived_only=fresh archived_sends=0`. The mixed pool
must bind the live idle worker even though the archived worker matches the
requested work type. The archived-only pool must bind a fresh session.
`archived-worker-reuse.json` records both bindings and the start/send calls.
No real Desktop session or model is used.
