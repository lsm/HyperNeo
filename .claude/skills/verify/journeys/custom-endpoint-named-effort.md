# Custom Anthropic endpoints send the chosen named effort

From the repository root, run the isolated proof with pinned Bun and a fresh
evidence directory.

```bash
bash .claude/skills/verify/proof-run.sh /tmp/named-effort-evidence .claude/skills/verify/custom-endpoint-named-effort.ts
```

The helper builds the options for a session on an Anthropic Messages custom
endpoint through `QueryOptionsBuilder`. It starts the real custom provider and
its bridge, then runs one real SDK `query()` turn per case against a loopback
upstream that records the `/v1/messages` body the endpoint receives.

- A model with `capabilities.namedEffort: true` sends adaptive thinking with
  `output_config.effort` `low` for Low and `high` for High, and no token budget.
- Off on that model is byte-for-byte what a model without the capability gets:
  disabled thinking and no HyperNeo-chosen effort.
- A model without the capability keeps the fixed budget: Low arrives as
  enabled thinking with `budget_tokens` 8000.

Retain `result.json` with `verified` and `resourcesClosed` true and wrapper
exit 0.

The capability has no Settings control. It is set on the model in the custom
endpoint config, and the Settings editor keeps it when the endpoint is saved
again.
