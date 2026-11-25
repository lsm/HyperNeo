# Configure new Antigravity CLI work

Use the isolated daemon and pinned Bun from the Verify skill:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/config-evidence \
  .claude/skills/verify/antigravity-find.ts config
bash .claude/skills/verify/proof-run.sh /absolute/unsupported-evidence \
  .claude/skills/verify/antigravity-find.ts config-unsupported
bash .claude/skills/verify/proof-run.sh /absolute/unconfirmed-evidence \
  .claude/skills/verify/antigravity-find.ts config-unconfirmed
```

Verify that `operations.describe` documents the model and effort options for
new Antigravity sessions. `work.start` sets the model before selecting from the
updated reasoning options. `work.start` and `work.status` report the confirmed
settings. If an effort is unavailable after the model changes, or the CLI
acknowledges a setting while reporting a different value, the driver closes
the new CLI session before submitting any work.

For an attended check, use a signed-in CLI to start a disposable turn with
an advertised model and effort. Confirm both values in the returned work
status and observe the model reply. An effort missing from the selected
model's options must be refused before any model reply can be produced.
