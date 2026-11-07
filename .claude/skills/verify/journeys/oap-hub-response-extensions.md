# OAP hub response extensions

Use shared isolation, the resource guard and pinned Bun from `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-hub-response-extensions.ts
```

The helper starts an isolated daemon on an ephemeral port and an owned synthetic
stdio hub. Every success response carries extra metadata. The first submit also
returns a busy refusal with an extra field, then accepts its one delayed replay.
An authenticated RPC message must persist the completed reply through the
production query adapter and codec. The socket, daemon and child close before
temporary data is removed. Real hub-version interoperability remains unverified.
