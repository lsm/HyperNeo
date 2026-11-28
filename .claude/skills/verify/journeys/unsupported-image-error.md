# A model without image input reports the upstream error

Use the isolated proof setup in ../SKILL.md and run:

```bash
bash .claude/skills/verify/proof-run.sh /tmp/unsupported-image-proof .claude/skills/verify/unsupported-image-error.ts
```

The helper sends image requests to the real custom Anthropic HTTP bridge backed
by a local fixture. Require two responses in `proof.log` and exit code zero.
The unsupported-image response must keep the upstream message and return
HTTP 400 with retries off. The separate overload response must still return
HTTP 529 with retries on. This covers the API response consumed by the SDK.
