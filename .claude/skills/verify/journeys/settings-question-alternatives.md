### Settings question alternatives

```bash
RUN=$(mktemp -d /private/tmp/hn-preference-alternatives-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/pack-preference-alternatives.ts 9355 "$RUN"
```

The helper uses the real daemon registry's MCP door for Neo and the WebSocket
operation door for the human, like `immutable-settings-proposal-answers.md`.
Neo asks `pack.preferences.ask` with three `sessionStrategy` alternatives for one
synthetic repo. The daemon's question must be a single choice with one labelled
option per alternative, then Use the default for now. Before the human answers,
nothing is saved, and Neo can neither answer the question nor apply it. The
human picks One session per PR; only `per_pr` is saved, with human provenance.
After a daemon restart the value and consent remain, a retry with the same
request id and different alternatives is refused as immutable, and a
questionId-only apply changes nothing. Replies are kept in
`evidence/observed.json`.

No live database, provider, credentials, model or GUI is used. Browser rendering
of the card is not verified here.
