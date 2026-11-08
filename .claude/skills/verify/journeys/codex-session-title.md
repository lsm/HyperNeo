# Codex session titles and offline rename

Use the pinned runtime and disposable metadata proof wrapper from SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/codex-session-title.ts
```

The helper boots an isolated daemon on an ephemeral port, with synthetic Codex
state and scripted server boundaries. A parsed todo start target carries
sessionTitle through driverWorkCall and the real work.start operation. The
created thread and returned title use that session title independently of the
todo title. Omitting sessionTitle selects the next free generic project name
among live project threads, never the task title. work.rename succeeds while the Desktop control connection throws,
using the owned bootstrap server. Every opened server is closed.

Retain codex-session-title.json, proof.log and run-status.json. No model, native
Desktop, live daemon or real Codex state is used. Browser rendering and actual
installed app-server compatibility remain unverified.
