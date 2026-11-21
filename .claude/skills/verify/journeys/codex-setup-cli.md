## Codex setup command

On macOS, use the pinned Bun and isolated proof wrapper from `SKILL.md`.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/codex-setup-cli.ts
```

The real HyperNeo CLI talks to the isolated daemon through its paired local
session socket. A synthetic managed Codex server reports an active thread and
the proof confirms that migration and undo wait for idle. The proof runs setup with
and without remote control, repeats setup to rotate the token, restarts the
daemon to reapply the bridge, and exercises undo after both a migrated bridge
and a distinct original URL. The app and launchd commands are recorded by a
subprocess fixture. Retain `proof.log` and `run-status.json`.

Live Desktop, paired-phone access and macOS logout/login remain separate
checks in the signed setup design. This journey does not change the host login
environment or start or stop the host's Codex app.
