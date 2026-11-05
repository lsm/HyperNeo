# Codex accepts the work-location instruction field

Use SKILL.md's shared isolated wrapper with an explicit installed executable:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/codex-work-locations-schema.ts "$(command -v codex)"
```

Repeat with the executable selected by startCodexBootstrapServer. The helper
generates each binary's public app-server schema with a fresh HOME/CODEX_HOME,
then requires ThreadStartParams to declare developerInstructions as text.
codex-work-locations-schema.json retains the version and field declaration.

Observed versions are standalone codex-cli 0.160.1 and Desktop-bundled
0.164.0-alpha.11.1; both declare string/null. No model turn, authentication,
Desktop rendering or claim of native shell environment application is involved.
The schema command exits normally and the wrapper removes its temporary data.
