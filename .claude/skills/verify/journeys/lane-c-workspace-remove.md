# Remove workspace history through the DB writer

Use proof-run.sh with lane-c-workspace-remove.ts on Bun and cached native Deno
(VERIFY_PROOF_RUNTIME=deno). The wrapper checks resources, scrubs credentials,
uses disposable HOME/data and ephemeral listeners, saves evidence and deletes
the synthetic daemon data after cleanup. No provider turn, HTTP mock, live daemon,
real credentials or existing workspace is involved. Record actual runtimes;
local Bun 1.4.3 does not establish pinned native Bun 1.4.2 coverage.

Commit the failing proof first: real workspace.remove reaches a denied main
DELETE. The change is a thin data-only writer bridge around the existing remove
transaction, plus one awaited RPC call. Keep both deletes and membership cascades
inside one immediate writer transaction. Only the path crosses the boundary;
no callbacks, filesystem access or network run inside it. Register the unique op
and one self-contained Deno smoke line append-only. No shared core wiring changes.
Measure the entire changed business call graph and production diff below 200.

Self-check cached/new main SQL guards for DELETE workspace_history/projects, then
keep them denied. Seed only synthetic history/project rows and owned directories.
Call the real workspace.remove WebSocket RPC and observe its boolean receipt and
workspace.history readback. Removing the last folder removes its empty project;
a shared project's remaining folder/project stays. Files in the workspace remain
byte-identical. Missing paths retain false while existing empty-project cleanup
still runs. A trigger rejecting project cleanup must roll back the history delete
and membership cascade. Concurrent removals have exactly one true result.

Hold a separate synthetic WAL writer for 1.2 seconds: the RPC must not reply early,
history still shows the committed entry and system.health remains responsive.
The affected write intentionally includes the lock wait and cannot meet a 250 ms
write target; report that latency separately from first/uncontended RPC timing.
Fail before post and lose a committed reply: preserve the correct state, propagate
the original error, and never automatically replay. A later independent retry of
a committed removal returns false. Save byte/timing/RSS/WAL metrics, loop lag and
zero target main SQL attempts; do not claim SQL/queue times are isolated.

Run the focused strict test checker, handler/project/gateway contracts, repository
checks and cap measurement. Close the owned transport, lock, processors and daemon
before proof-run saves evidence and removes temporary data. The slice covers only
workspace.remove. Workspace addition, project-folder/startup writes, history reads,
MCP scans, browser layout and deployment remain separate; no workspace files are
deleted by the RPC.
