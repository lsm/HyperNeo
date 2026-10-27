# Catalog defaults use saved canonical choices (Tools 7c)

Use shared setup in `../SKILL.md`. Build web with the resource guard, then run:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/catalog-tool-defaults.ts
```

This metadata-only helper owns an ephemeral isolated daemon, synthetic DB,
refusing GitHub/Claude executables and the built Settings web surface. It makes
no provider turn and starts no external MCP server. Its log prints a CATALOG
URL and the exact PID; open it in an attended browser. Do not run unattended GUI.

The synthetic Fixture Server has no wrapper. Both it and Fixture Guide have
legacy flags off but saved global defaults on. A cold manual session has already
frozen those on choices. Observe both catalogs showing on and explaining
new-session defaults, existing sessions keeping their choices, and Tools → Use
here for a per-session change. There must be no no-wrapper runtime warning.

Turn Fixture Server off in MCP Servers. Observe the changed switch immediately,
then reload and confirm it stays off. In Skills, turn Fixture Guide off and
repeat. Keep other switches unchanged. Check readable row controls at desktop
and narrow window widths, closing the navigation drawer if it obscures them.
Retain screenshots and rendered text before/after each edit and reload.

Close the temporary tab and send SIGUSR1 to the printed helper PID. The helper
requires both saved defaults off and the existing session's frozen on choices
unchanged, then closes all owned resources. Inspect catalog-tool-defaults.json
for pass=true and resourcesStopped=true; the wrapper must exit zero and remove
its temporary daemon data. Screenshots and browser interaction supply the UI
proof; the helper alone proves only persistence and frozen-session preservation.

Before the fix use the same helper with `--baseline`: both fixture switches
incorrectly show off and the wrapper-free server claims toggling has no effect.
Do not edit in that baseline run. Preserve baseline evidence and the failing
CatalogToolDefaults component regressions before implementation. Run the two
existing catalog suites as well. This verifies default editing, not provider
execution, observed running attachment, live reload or ACP behavior.
