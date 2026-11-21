## Codex setup host and idle cutover

Use the pinned Bun version and the isolated proof wrapper from `SKILL.md`.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/codex-setup-host.ts
```

The production host reads a synthetic managed Codex app server over a real Unix
socket. An active thread on the second page of loaded threads defers restart.
After the next idle check, the fixture pauses the quit command and attempts a
HyperNeo send. The send runs only after the reopen command completes. The fixture
also checks the two legacy agents, the remote-control command, environment
round trips and repeat migration. All OS commands use a recording subprocess
fixture. They do not touch the Mac login session or launch either app.

Also run `codex-app-server-bridge.md` to verify the existing opt-in startup and
shutdown through the real HyperNeo daemon. Retain both proof logs and exit codes.
The shared setup command, Neo card and live Desktop, phone and login proofs
belong to later setup slices.
