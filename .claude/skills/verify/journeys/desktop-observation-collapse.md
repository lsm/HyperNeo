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

Run the [desktop call journey](desktop-call.md) on the shipping tree to check
that the SDK sends the original result and the host receives `since: latest`.
In the build host's disposable proof source only, switch the code constant to
true and rerun that journey with `--collapse` after the helper path. The live SDK
and synthetic host must now show a collapsed old result and a full snapshot
request without `since`. The transcript must still retain the original result. Restore the shipping source after the run.

This checks endpoint behavior and full-snapshot dispatch. The separate rollout
requires the recorded Calculator, TextEdit and Safari model replay in the design.
