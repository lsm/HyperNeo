# OXAP Codex chat continuity

Use the shared isolation and pinned Bun in `../SKILL.md` and the pinned
OXAP release binary described in `oxap-hub-settings.md`.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 folderless
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/second/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 model-switch
```

`folderless` leaves the workspace field unset. The native thread opens in
the daemon's current directory and the chat receives a reply. `model-switch`
requests a new model while the first turn is running, then sends as soon as
the first reply and new model are available. The second turn must reach the
new model on the original thread.

For an explicitly requested live Codex proof, append the absolute path of a
wrapper that runs the real Codex CLI with its existing signed-in home. Clear
`CODEX_HOME` in the wrapper, set `HOME` to the signed-in home, and pass all
arguments to Codex. The daemon and hub retain the disposable home and data
directory. The live switch runs after the first reply. The second reply
recalls a marker from that conversation. The third reply recalls the marker
again after the disposable hub restarts and resumes the original thread.
Use new evidence directories for the live runs.
