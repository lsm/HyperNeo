# DeepSeek discovered model metadata

Run `deepseek-discovery.ts` through `proof-run.sh` with the pinned Bun runtime.
The helper owns an isolated daemon on an ephemeral port, a disposable HOME and DB,
and an authenticated local RPC connection. Its DeepSeek fetch implementation only
returns synthetic responses. No live provider request or provider environment key
is used.

Require `models.list` to return the remote name and context for an existing ID,
retain the missing fallback ID, select tiers from discovered names and use the
remote context in SDK configuration. Vision remains false. Retain
`deepseek-discovery.json` with passed true and resourcesClosed true, plus the
wrapper exit status. The wrapper removes temporary data after retaining evidence.
