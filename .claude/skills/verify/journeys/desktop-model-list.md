# Desktop-control model list at worker start

A desktop worker started without a named model takes the first model in the
`desktopControlModels` setting that can see screenshots, use tools and run
now. The worker keeps that ordered list in its metadata.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-model-list.ts
```

The runner starts an isolated in-process daemon on a random port with its own
HOME and database and no provider keys. It adds three custom endpoints on one
loopback model server: `eyes-off` (OpenAI Chat, no Vision), `desk-first` and
`desk-second` (Anthropic Messages). It saves the list in that order through
`settings.global.update`. Neo then proposes a desktop todo, the human door
answers its card, and the todo starts with no model or provider.

Pass prints `desktop model list start PASS` and
`desktop model list exhausted PASS`:

- `desktop-model-list-start.json`: template `worker.desktop`, model
  `desk-first`, effort `think8k` from the list, a chain of `desk-first` then
  `desk-second`, and one turn received by the model server for `desk-first`;
- `desktop-model-list-refused.json`: with only `eyes-off` listed, the next
  desktop todo is blocked with `unsupported_model` naming the desktop-control
  model list, binds no worker and sends no model request.

Negative control: with the lifecycle change reverted the first assertion fails,
because the worker starts on the general default instead of the list.

Not covered: recovery to a later list entry during a turn.
