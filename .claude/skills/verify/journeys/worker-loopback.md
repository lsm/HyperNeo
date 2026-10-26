# Workers can run local test servers

Use the shared isolation and resource preflight in `../SKILL.md`. Supply absolute
paths to the installed native Claude and Codex executables:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/worker-loopback.ts "$(command -v claude)" "$(command -v codex)"
```

This creates disposable Git workers and installs their production sandbox settings.
The real native CLIs execute Bash against a loopback scripted model. Each shell
starts a real HTTP server on an ephemeral 127.0.0.1 port and connects to it without
the HTTP proxy. No model service, credential discovery or live daemon is used.
The Claude child alone receives a synthetic key for the local model, as described
in the shared native-worker setup. No sandbox bypass or permission relaxation is
injected. Existing outside-write, policy-protection and private-temp checks remain.

Inspect `{claude,codex}-observed.json`: `localServer.connected` must be true and
`outsideRefused` must remain true. The stdout JSONL retains actual shell results;
baseline Claude must lack the local-server receipt and report an OS binding denial.
The wrapper saves failures separately, releases private runtime roots and removes
the disposable workers. This proves native CLI enforcement on the current host;
native Desktop UI, Linux and Windows behavior require separate verification.

## Unit fixture isolation

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/fixture-evidence \
  .claude/skills/verify/worker-loopback-fixture.ts
```

This runs the real written-settings tests with a private simulated system temp
directory containing an unrelated stale worker marker. Before nesting the fixture
worker under its own parent, installation scans that marker and fails on the
unrelated missing settings directory. After the fix all settings tests pass and
`fixture-isolation.json` records the stale marker unchanged with no policy written
there. The simulated shared directory belongs entirely to the proof; the host's
shared temp entries are never seeded or changed.
