# OXAP hub from settings

Use the shared isolation and pinned Bun in `../SKILL.md`. Supply the pinned OXAP
binary for this platform (its `--version` must print the release name, for example
`oxap-0.1.0-alpha.39-macos-arm64`) with that name and its SHA-256:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 settings-restart
```

The helper starts an isolated daemon and a synthetic Codex app-server peer. It
packs the supplied binary into a local copy of the release and its
`SHA256SUMS.txt`, and answers only the release URLs in-process. It chooses OXAP
Codex for the `anthropic-codex` provider through `operation.invoke`
`oxap.settings.save`, so the daemon installs the hub from that release copy and
records its path, version and hash in settings. No `HYPERNEO_OAP_*` variable is
set.

It checks that a turn runs through the real hub, the served `oap-serve.json`
names the adapter after the provider, lists `HOME` and `CODEX_HOME` by name and
holds no key, and that re-saving another executable restarts the hub and the
next turn runs on the new entry without a second download. A relative executable
path is refused. Saving the provider back to Claude Code retains the executable
and the next turn completes in the existing OXAP chat. The other
`oap-workspace-wire.ts` modes take the same arguments and install the hub the
same way.

For `settings-restart-web`, build the web bundle, put Node on PATH, and set
`VERIFY_BROWSER` and `NODE_PATH` as described in `../SKILL.md`. The browser opens
the provider card, edits the retained executable with Claude Code selected and
reloads to observe
the saved field. A fourth turn in the existing Codex chat runs on that executable.

The real GitHub download and its published checksum are not exercised; unit
tests cover the checksum match and refusal.
