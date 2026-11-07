# OAP verified executable snapshot

Use shared isolation, the resource guard and pinned Bun from `../SKILL.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/oap-verified-executable.ts
```

The helper creates an isolated daemon and a synthetic executable. Its --version
handler replaces the installed path with an executable that would write a bad
marker. The production OAP engine must start the checked snapshot, and a real
RPC message must persist the expected reply without running the replacement.
A pre-existing stale oap-verified-x directory must be removed before startup.
Closing the engine must remove the new snapshot. The socket, daemon and child close
before temporary data is removed. Real packaged-binary relocation remains
unverified by this synthetic journey.
