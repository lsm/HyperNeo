## Every WebSocket requires a credential

Read SKILL.md isolation and resource rules. Run:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/ws-credential-admission.ts verify
```

The helper starts a real daemon on an ephemeral port with a fresh HOME/data/DB,
then drives its HTTP, WebSocket and Unix-socket CLI doors. No providers or live
credentials are used. It preserves only statuses and boolean outcomes:

- Anonymous, unknown and proxied anonymous clients are refused before upgrade.
- A local owner-only credential and source CLI can read the build.
- The first CLI code still bootstraps; later codes wait for paired-human Allow.
- A browser pairs through POST /pair, receives only an HttpOnly cookie, and reads
  owner RPC with that cookie. A paired daemon uses Bearer and its work allowlist;
  owner operations remain refused for that kind.
- A random peer credential is unknown to device authentication and cannot open WS.
- No token is written to proof output; sockets and daemon close before cleanup.

The web entry checks GET /ws using its existing cookie and renders PairPage on
401. Device pairing's browser journey covers the real PairPage interaction.
This proof does not claim an attended phone or browser visual acceptance.

Credential startup regressions are in
`packages/daemon/tests/unit/1-core/pairing/local-credential-creation.test.ts`:
interrupted writes must not expose the final path, retry must succeed, and
concurrent starts must enroll the same completed credential. Run with Vitest;
the real daemon proof above also verifies the created credential reaches RPC.
