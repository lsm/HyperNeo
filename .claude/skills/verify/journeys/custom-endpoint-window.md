# A custom endpoint's real context window

Run `custom-endpoint-window.ts` through `proof-run.sh` with pinned Bun. The helper
owns a loopback SSE fixture that answers every request, and it runs the shipped
SDK CLI (`VERIFY_CLAUDE` overrides the binary) against that fixture.

Claude Code appends `[1m]` to a model it does not know when the session asks for
1M, and then assumes a 1M window. A custom endpoint whose model is below 1M must
instead reach the SDK as the bare model with its real window:

- Declare an anthropic-messages endpoint with `maxContextTokens: 256000`. Require
  `buildSdkConfig` to set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` and
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=256000`, and the SDK run's init model to be
  `swe-2-high` with `modelUsage.contextWindow` 256000.
- Declare the same model with `maxContextTokens: 1000000`. Require neither env
  var, init model `swe-2-high[1m]`, and `modelUsage.contextWindow` 1000000.

Retain `result.json` with `verified` and `resourcesClosed` true, and wrapper exit
0. The helper closes the fixture before the wrapper saves evidence and removes
temporary data.
