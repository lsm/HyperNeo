# OAP hub stderr diagnostics

Use shared isolation, the resource guard and pinned Bun from `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-hub-stderr.ts
```

The helper starts an isolated daemon on an ephemeral port and an owned synthetic
stdio hub. An authenticated RPC message submits through the production adapter
and client. The child writes over 100 KB to stderr, ends with a synthetic panic
marker and exits. The session must surface that marker in its error, omit the
old prefix and keep the error below 17,000 characters. The client emits exactly
one structured failure log carrying the marker. The socket, daemon and child
close before temporary data is removed. Real provider failures remain unverified.
