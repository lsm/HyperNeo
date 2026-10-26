# Current-query inventory RPC (approved Tools slice 2)

Use the shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/tools-live-capture.ts`. No HTTP model mock or port
preflight is needed: the helper owns an ephemeral non-8399 daemon and uses a
scripted SDK, with no provider traffic. Its synthetic provider credential is
stored only in the fresh fixture DB, never an environment variable or keychain.
External registry servers are disabled before the session starts. The MCP fixture
is a real SDK server/client linked in memory; its one tool does not open a browser.

The helper calls actual session/message RPCs over WebSocket. Pass requires:

- A stopped inventory read returns not_running without creating a query.
- A human message starts a scripted SDK query; its init tools, skill and plugin
  names appear through session.getToolInventory. Live MCP status supplies the
  synthetic tool name. Config, private plugin paths and raw diagnostics do not.
- A failed status refresh reports that server unverified, with unknown tools.
- An old status RPC is held while its query ends and a later input creates a
  replacement. The scripted SDK writes no transcript, so follow the actual
  sdk_resume_choice prompt through its public start_fresh RPC. A delayed old
  status must return the replacement's facts, never the stale server.
- Reconnecting a WebSocket returns current facts. Ending and unloading the
  synthetic session, then reloading persisted history through the RPC, returns
  not_running and creates no new query. Historical init is not current evidence.
- A fixture configured as ACP returns unverified and no tool facts. No real ACP
  connection or its browser execution is claimed.

The helper asserts every condition, writes `evidence/live-inventory.json`, and
closes its owned sockets, daemon, delayed status and MCP transports in finally.
A missing pass field or any false/incomplete assertion is not a pass. Earlier
fixture runs that stopped at the missing-transcript choice are inconclusive for
replacement, not successful proof.

Focused daemon tests: query-runner-startup-gate.test.ts (six new failing cases
committed at be6bc9d041), query-runner.test.ts, observed-tool-inventory.test.ts
and sdk-runtime-config.test.ts. The read API is wired; the Tools panel remains
unchanged until slice 3. This journey does not verify its labels or controls.
