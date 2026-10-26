# Model list survives a cold SDK and a stalled provider

Use the shared resource guard and isolated in-process setup in ../SKILL.md with
PROOF=.claude/skills/verify/model-discovery-isolation.ts. No model API, provider
key, browser or real database is needed. The helper starts its own daemon on an
ephemeral non-8399 port and calls the actual models.list WebSocket door.

A synthetic provider answers at 15 seconds (matching the 15.2-second measured
first x64 SDK handshake under Rosetta); another provider never answers. Both
must start together. Forced refresh returns the answering provider's available
model, identifies the stalled provider as unavailable, and finishes within 35
seconds. The baseline errors at 10 seconds. Retain the full log and
model-discovery.json even on failure; the helper closes its daemon in finally.

Unit coverage separately exercises the actual AnthropicProvider SDK deadline,
partial forced refresh and concurrent stalled-provider isolation. The proof does
not replace fresh compiled CLI checks: after merge, rebuild both release
architectures and rerun release-candidate-fresh-install.md from the release PR.

For the authorized live performance comparison, use only the coordinator-approved
instance and port. Measure models.list (cached and forced) and count providers in
memory; never dump configuration or credentials. A loopback-only remote listener
may be measured through an existing authorized SSH connection. Do not change its
configuration, restart it, or contact any prohibited port. Record the before build
and timing; the after measurement is pending until the coordinator deploys the fix.

## Browser request budget

Web requests must outlive daemon discovery; raw WebSocket calls alone cannot
prove the client timeout. The shared provider protocol declares the 30s provider
window and a 65s model-list request window (a forced call may join one in-flight
pass before starting its own). All five web models.list call sites pass this
method-specific budget; unrelated hub requests keep their existing default.

Build packages/web, then run the same helper through proof-run.sh with three
extra arguments: the absolute Node executable, the directory containing
Playwright's node_modules, and the installed Chromium executable. The wrapper
appends the fresh run directory as usual. Example:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/model-discovery-isolation.ts \
  "$NODE" "$PLAYWRIGHT_MODULES" "$CHROMIUM"
```

After the RPC proof the helper clears only its synthetic model cache and starts
the owned headless browser while keeping its own daemon alive. Real Settings >
Models must load the cold model after ~15s without the old 10s error. The helper
serves the built frontend on its own ephemeral listener with that daemon's actual
WebSocket handlers and access checks. Clicking
Refresh models joins the remaining initial pass and then starts forced discovery,
so that reply takes ~45s. It must still populate the real model chooser with no
error. Inspect model-discovery-browser.json (timed WebSocket replies) and the PNG.
Component tests also use the real MessageHub timer for a 15s load and a 60s forced
reply, instead of mocking hub.request. Browser and temporary daemon data are
closed and cleaned by the owned helpers; this never touches a live instance.

The browser also opens Settings > Neo model and clicks Refresh models. Its
forced list must return the cold model without an error or a Neo/global
preference write. Retain model-discovery-neo-browser.png and the JSON's
neoRefreshWithoutPreferenceWrite result. The focused NeoModelsSettings suite
asserts the model-list request's third timeout argument as well as no save.
