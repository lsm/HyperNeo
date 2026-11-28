# Start Cursor CLI work with a model and effort

Use the isolated daemon and pinned Bun from the Verify skill:

```bash
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/cursor-config-evidence \
  .claude/skills/verify/cursor-start-config.ts 9389
```

The proof runs a real daemon over `operation.invoke` against a fake
`cursor-agent acp` that behaves like cursor-agent 2026.11.22. A client that
initializes with `clientCapabilities._meta.parameterizedModelPicker: true` gets a
`model` select option keyed by model name. Once a model is chosen, it also gets
that model's `thought_level` option, named `effort`, `reasoning_effort` or
`thinking`. Without that flag, Cursor offers only fixed variants, such as
`claude-opus-5-5[context=300k,effort=medium,fast=false]`, and refuses other
efforts with -32602. The fake CLI does the same.

Verify the following:

- `work.adapters` lists `cursor-cli` as configurable, and `operations.describe`
  says Cursor CLI accepts model and effort.
- `work.start` with model `claude-opus-5-5` and effort `high` sets the model,
  then the effort, before the first `session/prompt`. `work.start` and
  `work.status` report both values, and the reply comes from that setting.
- An effort the model does not offer returns `unsupported_effort`, and a model
  Cursor does not offer returns `unsupported_model`. Neither sends a prompt.
- When the CLI acknowledges the change but keeps the old model, the start
  returns `not_delivered` and no prompt is sent.

The evidence is `cursor-acp.jsonl`, the ACP frames the fake CLI received, and
`cursor-start-config.json`.

For an attended check, use a signed-in `cursor-agent acp` with the flag above.
Run `session/new`, set `model`, then set the returned `thought_level` option,
and confirm both `currentValue`s. Cursor saves the selection as the CLI's
default model and the model's saved parameters, so set them back afterwards
(for example `effort` back to its old value, then `model` to `default`). If the
account's plan allows only Auto, other models reply "Upgrade your plan to
continue", and those sessions cannot be loaded again.
