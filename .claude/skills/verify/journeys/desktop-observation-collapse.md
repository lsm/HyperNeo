# Desktop observation retention on custom endpoints

Run on the build host with the pinned Bun and the isolated wrapper from SKILL.md.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-observation-collapse.ts
```

The helper submits synthetic desktop steps to both real bridge HTTP endpoints.
It records upstream requests and compares full and collapsed bodies, the latest
failure, the order of retained target fields, the unchanged prefix and non-desktop
content, and the count request or estimate. Pass prints
`desktop observation collapse PASS` and writes `desktop-observation-collapse.json`.

While the rollout flag is off, run the [desktop call journey](desktop-call.md) to check
that the SDK sends the original result and the host receives `since: latest`.
Run the enabled case through the isolated proof runner:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-call-collapse.ts --collapse
```

The runner substitutes the enabled constant in memory for that test process.
The SDK and synthetic host must show a collapsed older result and a full
snapshot request without `since`. The stored transcript keeps the original
result.

This checks endpoint behavior and full-snapshot dispatch. The separate rollout
requires the recorded Calculator, TextEdit and Safari model replay in the design.
