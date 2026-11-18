# OXAP submit carries the chosen model

Use the shared isolation and pinned Bun in `../SKILL.md`, and the pinned OXAP
binary as in `oxap-hub-settings.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 model-id
```

The helper creates an OXAP Codex chat whose stored model is the alias
`codex-6-luna` and sends one message through the real hub. The hub's Codex
adapter advertises `run.model_selection`, so the daemon adds `model_id` to the
submit. The proof passes when the synthetic Codex app-server's `turn/start`
carries `gpt-6-luna`, the provider's canonical id. Before this change it carried
no model, so the run used the harness default.

A harness that does not advertise `run.model_selection` is covered by the unit
test in `oap-query-hub.test.ts`; no such harness row exists yet.
