# Shared initialization controls (#8180, final part of #8102)

> Historical migration journey: legacy rendering has been restored. For current
> legacy verification use [legacy-chat-compact.md](legacy-chat-compact.md); the
> explicit-more assertions below describe the superseded migration, not current behavior.

There is **no active runtime caller** for these initialization variants on this
head: normal SDKMessageRenderer hides init, no production caller passes its
`taskContext` flag, and nested init is filtered before SDKSystemMessage dispatch, and direct init is
only reached by component consumers. Do not claim expanded initialization proof on the app session route.
This journey separates component-browser coverage from actual runtime hiding.

Use the shared isolated setup and a fresh synthetic run. Build web first, then:

```sh
RUN=$(mktemp -d /private/tmp/hn-sdk-init-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-init-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test \
  bun .claude/skills/verify/sdk-init-preview-server.ts "$RUN" "$FIXTURE_PORT" "$PORT"
```

Choose free ports other than 8399; the fixture server also fails if its port is
occupied. Keep the shell alive. The fixture serves the real two Preact components
with synthetic metadata, compiled into `<run>/component`, and loads CSS from the
isolated daemon. Its page explicitly says **Component-only initialization
preview**. It creates no product route and triggers no provider turns.

In persistent headless Playwright with five-second locator timeouts, import
`sdk-init-disclosure-web.mjs` and call
`verifySdkInit(page, { daemon: port, fixture: fixturePort, run, width, phase })`
at 1280/390. Run `before` on original controls and `after` on the rebuilt fix.

| Surface | Claim / observable check |
| --- | --- |
| Labeled component fixture | Title clicks stay closed; Enter opens, body click and dragging select text without toggling; Space on less closes; focus survives both moves |
| Labeled component fixture | Full directory/tools/MCP/agents metadata remains readable; controls sit at the right edge; no document overflow at either width |
| Actual isolated session | The seed stored an init message; after normal session content loads, init model, Session Started and init controls remain absent |
| Both | Inspect before/after screenshots separately from JSON measurements; doctor says usable |

Screenshots disable animation only during capture. Record component screenshots
with the `component-` prefix and runtime hiding screenshots with `runtime-`.
Expanded initialization is **not verified in an active app flow**; do not promote
the fixture to that claim. Native iOS and real providers are not covered.

Keep the JSON, screenshots, doctor output and test logs in the PR. Close the
owned browser; Ctrl-C the owned fixture server, then stop only this run with
`stop.sh "$RUN"`. Preserve its synthetic data/evidence. No shared SKILL.md or
index edit is needed.
