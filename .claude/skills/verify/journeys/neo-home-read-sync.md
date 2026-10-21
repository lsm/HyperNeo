# Curated home read sync once per Neo wake

From the worktree root, choose a fresh absolute synthetic directory:

```bash
bash .claude/skills/verify/neo-home-read-sync.sh "$RUN"
```

The helper owns an isolated test HOME, data directory, database and daemon on an
ephemeral loopback port. It creates a first-machine repository and local bare
remote, then selects that home through the actual human `operation.invoke` RPC.
A synthetic Neo session is opened through RPC. The real SDK MCP server is connected
to a protocol client with the MCP in-memory transport; its caller is bound to a
real `NeoCoordinatorTurn` in the isolated daemon's operation catalog. No model
turn, provider, credentials, GUI or port 8399 is used. GitHub is stubbed.

The first MCP home read must fetch the peer's new direction. More peer changes
must remain unseen during concurrent reads of direction and mandate in that same
wake, with exactly one fetch. A fresh runtime turn must read those changes. A
missing remote must produce one shared failure even after the fixture restores
origin; only a new turn retries. Each human RPC read must independently refresh.
The fixture Git wrapper records fetch invocations while delegating to real local
Git; it does not implement production command policy.

An uncommitted synthetic human edit before a new wake must return `dirty`, leave
HEAD and the edit unchanged, and perform no fetch. Local-only homes remain readable
with human edits. A successful wake sync caches the attempt, never document text:
focused contracts also observe later local edits in the same wake. They additionally
cover peer-added documents, symlink replacement during sync, isolated rebase conflict
refusal and caller identity objects refreshed around the same runtime closure.

The cache uses the runtime-owned isLive closure as its weak key: it remains stable
when steering updates the turn identity, and is not supplied by operation input.
Human RPC and unbound MCP calls have no wake key and get independent attempts.
Native Read and its existing policy are unchanged; curated synced reads use
`neo.home.read`. The separate conflict-question slice is not implemented here.

`evidence/neo-home-read-sync.json` retains actual RPC/MCP replies even on failure.
The pre-fix reproduction returns `Initial` after the peer pushed `Peer one`.
Fixed evidence ends with six recorded fetches (the retained counter file is named `pulls`), the expected refreshed documents,
a shared failure and an unchanged dirty human edit. The helper closes its MCP
client/server, turn, WebSocket and daemon in `finally`. Real network authentication,
a complete SDK/model turn and killed-process recovery are not verified.
