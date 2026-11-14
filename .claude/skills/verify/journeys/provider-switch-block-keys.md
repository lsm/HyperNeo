# A provider switch leaves history the new provider accepts

Use SKILL.md's isolated metadata-only proof wrapper and resource check:

```sh
bash .claude/skills/verify/proof-run.sh <absolute-fresh-evidence-dir> .claude/skills/verify/provider-switch-block-keys.ts
```

The helper starts an ephemeral real daemon on a free port with two synthetic
providers, Anthropic and GLM, whose credentials live only in the fresh DB. Its
scripted SDK answers the first prompt with a rate-limit result after writing a
transcript whose tool_use block also carries `text` and `thinking` keys, as
another provider can produce. The fallback chain then moves the session to GLM.
When the fallback query starts, the helper reads the transcript the CLI would
replay to the new provider.

Require wrapper exit zero, the session ending on provider `glm`, and the replayed
tool_use block holding only `type`, `id`, `name` and `input`. On the baseline the
same check fails with the extra `text` and `thinking` keys still present; keep that
failing evidence before changing the switch path. Preserve
provider-switch-block-keys.json, proof.log and run-status.json.

It refuses external HTTP and drives no browser, credential file, live daemon or
port 8399. It verifies what the daemon leaves on disk for the resumed turn; the
upstream API's response and /compact against a real provider remain unverified.
