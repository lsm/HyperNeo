# OXAP Codex CLI path and launch errors

Use the isolation, pinned Bun, current web bundle and browser setup in
[the verify skill](../SKILL.md). Use the pinned OXAP binary and its release
name and SHA-256 as in [the hub settings journey](oxap-hub-settings.md).

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 cli-path-web
```

On desktop and a touch phone viewport, select OXAP Codex in Provider Settings.
The Codex CLI field should show the detected fake Codex path. Trying to save a
fake OXAP executable should show a refusal. The journey then saves a working
fake Codex path and replaces the program on disk with the fake OXAP executable.
A fresh send on each viewport should show the saved path, the first stderr line
and the Settings pointer in the existing chat. The evidence directory contains
the field and chat screenshots from both viewports. The journey saves a working
path and confirms that the original chat can receive a reply.

Use `cli-path` for the same save and launch checks over authenticated RPC
without the browser. The synthetic executables perform no provider sign-in.
