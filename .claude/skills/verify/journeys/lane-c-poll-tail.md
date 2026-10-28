# Isolate GitHub poll event delivery failures

Run proof-run.sh with lane-c-poll-tail.ts on Bun and native cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup checks resources, scrubs credentials,
uses fresh HOME/data and ephemeral ports, saves evidence and removes owned data.
No provider/model, real GitHub, live daemon or actual credential is used. A fixture
collector supplies pages and later conditional 304 responses. The helper registers
the existing production github.poll handler on the isolated daemon processor,
using a production poller and GitHubService.processEvent callback sharing its DB/bus.
Credential bootstrap and GitHubService startup registration remain unverified.

The original full-service fixture hit the existing global filter upsert conflict
before polling; retain that setup-failure log, never count it as a reproduction.
The direct handler bridge avoids that unrelated setup path without replacing the
poller, job handler, event service, inbox writer or persistence being verified.

Before the fix require the actual poll job to finish yet retain only the first
uncertain inbox commit instead of six rows. Self-check main SQL traps, then refuse
inbox INSERT and single-ID receipt SELECT on main. After the fix require pass=true,
mainSqlAttempts=0 and four scenarios covering first/middle failures on issue/comment
pages. Each job must attempt all six callbacks once, retain six committed rows,
publish five exact committed notices and log one delivery rejection. The lost
receipt must not trigger a fallback or false success notice. Run the next actual
job with both page validators returning 304: zero extra writes/notices/rejections,
retained validators and since cutoff. No callback retry or ETag/cursor reset.

Unit contracts also cover synchronous throws, asynchronous rejections and a
blocked callback that must finish before later events start. Preserve the existing
polling-service receiver for ordinary callbacks as well. Pin the full polling
module outside its constructor, source/normalizer/job-handler roots and merged
event(185)/writer(84) subtrees by exact hashes/contracts in audited-dependencies.json.
The new constructor/wrapper graph must remain below 40 lines; only that production
file may change. No shared/core or smoke registration edit is permitted here.
Full imported SDK/network/collector/bootstrap closure is explicitly not measured.

Run focused poller/event/job suites, the strict checker, source/diff measurement
and repository checks. Save payload/response sizes, job timing, event-loop lag and
RSS/WAL without raw events or credential identifiers. Close subscribers, poller,
service, socket, processors and app before data cleanup. Native Bun 1.4.2 when a
different Bun is installed, real GitHub, bootstrap, browser and Neo-owned release
smoke remain unverified by this isolated job proof.
