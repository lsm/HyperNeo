# Activate GitHub inbox event writes

Run proof-run.sh with lane-c-inbox-event.ts on Bun and native cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources and scrubs credentials,
uses fresh HOME/data and ephemeral ports, saves evidence, then deletes owned data.
The helper owns a real synthetic daemon and a production GitHubService, with its
signed webhook handler on an additional owned listener. The service shares the
daemon DB/bus, has no provider key or GitHub token and uses short local security
checks. Credential bootstrap and the app's webhook bridge are not exercised.
No real GitHub, model, live daemon or existing workspace is accessed.

Before wiring require a signed webhook to acknowledge 200 but commit no row
because both legacy insertion attempts hit the main SQL trap. Self-check cached
and new traps before refusing inbox INSERT and single-ID receipt SELECT on main.
After wiring require pass=true/mainSqlAttempts=0. Actual signed HTTP issue/comment
requests publish exact committed inbox rows; a real high-risk security rejection
also commits its rejection record. Disallowed repositories and invalid signatures
never write. A synthetic filter exception retains one low-confidence fallback.

Hold another WAL writer for 1.2 seconds: both webhook completion and inbox notice
wait for the receipt, health remains responsive, and caller identity/time survive
queueing. This deliberate lock wait is not a sub-250-ms write pass. Corrupt receipt
JSON with a trigger and require rollback without a fallback or success notice.
Reject before post, then lose committed replies on accepted, security-rejected and
filter-fallback paths. Every request attempts one write only; uncertain commits
retain one row and emit no false receipt. Direct service unit tests require the
original rejection; the existing HTTP handler still acknowledges processing
errors with 200, and that transport behavior remains unchanged.

Pin the merged 84-line writer subtree and unchanged filter/security/HTTP roots
with exact hashes/contracts in evidence/lane-c-inbox-event/audited-dependencies.json.
Those full source files are pinned, but their full SDK/network/bootstrap transitive
graph is explicitly not measured. Run the focused unit contracts, strict checker,
local graph/diff measurement and repository checks. Save timing/payload/RSS/WAL
without raw payloads or paths. Close subscribers, sockets, service timers, listener,
locks, processors and app before data cleanup. Main-side counts/filter reads,
native Bun 1.4.2 when another Bun is installed, browser layout and Neo-owned
release deployment smoke remain unverified. The shared legacy facade is left for
core cleanup; no shared/core edits beyond one append-only smoke line are needed.
