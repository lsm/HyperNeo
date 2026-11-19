# Recorded and live voice tests

Run the metadata proof on an isolated test host:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/voice-test-input.ts
```

The helper drives the daemon's Neo MCP operations against local recorded and
live fake services. It verifies both success and redacted 401 errors, one second
of live silence, and that live testing never sends a batch request. Retain the
result, proof log and exit code. Saving a synthetic key through the settings RPC
also queues a Neo wake naming the host without exposing the key.
