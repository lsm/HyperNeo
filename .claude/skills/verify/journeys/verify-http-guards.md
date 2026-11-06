# Owned proof servers await the shared request guard

Use the shared isolation, pinned runtime and cleanup in SKILL.md.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/verify-http-guards.ts
```

The helper starts one real isolated daemon. It parses the actual fetch functions
from the session-tool-activation, tools-live-capture, error-workflow-server,
project-start-home, model-discovery-isolation, driver-health,
catalog-tool-defaults and claude-login-retry proof helpers. Each unchanged
function runs on its own sequential ephemeral HTTP/WebSocket listener, using the
real daemon guard, device authentication, transport and operation registry.
Assets are a synthetic local fixture. Broader feature setup and model/browser
work are omitted from this focused transport regression.

Every listener must serve its preview after an allowed guard result, refuse a
cross-site POST with 403, and complete paired neo.ask.read RPC for a missing
synthetic card. Inspect verify-http-guards.json for eight successful RPC rows,
200 assets and 403 refusals. Cleanup must report allServersStopped and the wrapper
must exit zero. This proves the helper HTTP and RPC doors, not the eight feature
UIs or their full journeys.

Before the fix, the eight fetch functions return the guard Promise immediately.
Normal traffic receives an invalid/null fetch response. The observed baseline
returned Bun's generic welcome page with status 200 rather than the preview,
leaving the intended preview and RPC routes unreachable. Retain that failing
receipt before adding the missing awaits.
