# Every model's real context window reaches the SDK

Run `custom-endpoint-window.ts` through `proof-run.sh` with pinned Bun. The helper
owns a loopback SSE fixture that answers every request, and it runs the shipped
SDK CLI (`VERIFY_CLAUDE` overrides the binary) against the env the daemon computes.

Claude Code appends `[1m]` to a model it does not recognize when the session asks
for 1M, and then assumes a 1M window. The daemon declares the real window instead,
from one rule in `QueryOptionsBuilder`: every non-native provider gets
`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<its
window>`; native Anthropic gets neither.

- Build the SDK env for a session per case through `QueryOptionsBuilder`, then run
  the CLI on it. Require the init model to be the bare name, `modelUsage.contextWindow`
  to equal the declared window, and no `context-1m` beta on the request:
  256000, 262144 (Kimi), 200000 and 1000000.
- A native Anthropic session must carry neither variable.

Retain `result.json` with `verified` and `resourcesClosed` true, and wrapper exit
0. The helper closes the fixture before the wrapper saves evidence and removes
temporary data.
