# OAP backend: opt-in Codex plan

The 2026-11-04 re-read retains the architecture but narrows the first delivery to an opt-in native Codex harness. This is a plan, not a claim of implementation. The re-read was a static check of source, GitHub and local files at HyperNeo `71e5a6106f` and OAP `147259e9bd`; it ran no oapx, real Codex or tests. Subsequent changes may have moved those baselines.

## Boundary and first path

A session explicitly selecting `harness: codex` would use native Codex app-server through `oapx serve --stdio`. A session without a harness continues on the Claude Agent SDK. ACP is not a current default path: the re-read found its runner removed. Other providers and automatic oapx download are outside this first path; the existing `anthropic-codex` bridge stays until real migration and no remaining users.

Use the existing `QueryLike` seam in `QueryRunner`, not a second runner. Translate OAP events into SDK-shaped messages, including exactly one terminal `result`, so existing delivery, attempt and generation handling, `sdk_messages`, chat storage, web, iOS and Neo turn facts can continue to work. The existing `OapStdioClient` speaks raw envelopes, not the hub request/reply/subscription protocol, so it cannot directly send hub operations.

Engine integration belongs in daemon `lib/oap/` and `lib/agent/`. Neo core continues to know work adapters and stored messages, not OAP; the `drivers/hyperneo-adapter.ts` seam passes the harness and records provenance. The coding pack stays unchanged. A web harness selector is a later entry point, not a rewrite of the clients.

## Identity, recovery and limits

Use the HyperNeo session ID as OAP `session_id` and store the Codex thread ID in existing `sessions.sdk_session_id`; add no identity table or column. Pass `--session-history` so the hub can persist its bindings. When a native ID exists and the adapter supports `session.open.reopen`, reopen using Codex `thread/resume`. Only `unknown_session` or `unsupported_feature` specifically for reopen permits opening a new session with a summary and a visible notice; infrastructure errors surface without fallback. Recovery never automatically replays a run or its tool side effects. Codex reopen across a hub restart still requires a real acceptance journey.

Initially exclude sessions with `toolGuards`, `workerOperations`, Space workflows or Neo root work: native Codex does not run the existing `PreToolUse` guard, and daemon tools and HyperNeo session instructions are not yet available. The proposed permission posture is `on-request` with `workspace-write`, subject to the decision below. Reject stale-attempt requests; unanswered requests wait, and pending requests after daemon restart count as denied. Codex uses its own login; configuration passes only allowlisted environment variable names, not keys.

A hub exit fails pending requests once, makes affected sessions idle and surfaces a notice; the next message can reopen. A Codex exit yields one error terminal. Only `busy` is eligible for automatic retry; reconnecting a subscription does not replay commands. Discard late events by attempt. Reject a binary with a mismatched version or checksum without affecting SDK sessions. Surface upstream limits rather than stacking SDK retries.

## Delivery lanes

S1–S6 can begin independently with injected interfaces or pure functions; estimates and concurrency are not measured guarantees.

| Lane | Scope | Dependencies |
| --- | --- | --- |
| S1 | Hub codec, then subprocess client, request correlation and subscriptions | None across lanes |
| S2 | Translate text and terminal events, then tools, thinking and usage | None across lanes |
| S3 | Inject the `QueryLike` factory; build `OapQuery` (#7479) | None across lanes |
| S4 | Harness selection with SDK default; reopen decision | None across lanes |
| S5 | Explicit binary version/checksum check; hub configuration and history | None across lanes |
| S6 | Map permissions and user questions both ways | None across lanes; mapping alone does not prove guards |
| W | Serial integration: W1 hub lifecycle; W2 opt-in query; W3 attempt and terminal lifecycle; W4 reopen | W1: S1b, S5a, S5b; W2: W1, S2a, S3a, S3b, S4a; W3: W2; W4: W2, S4b |
| P | Wire permission prompts, then prove approval, denial and guard exclusion in a real run | P1: W3, S6a; P2: P1 |
| M | Map models; add session harness selector | M1: W2; M2: S4a and avoid conflict with settings PR #10078 |
| N | Pass harness through the HyperNeo driver and verify provenance and real Codex turn facts | W3, M2 |
| E | Engine status and harness-tagged failure classification | E1: W1; E2: W3 |
| T | Connect daemon operation handlers as client tools and prove a real Neo operation | OAP O2b → T1 → T2 |

The upstream O1 instruction decision and implementation precede O2b client-tool implementation; O2a independently checks whether `thread/resume` retains dynamic tools. O2b also depends on the client-tool decision. A new OAP release pin is needed for real Codex acceptance, but not S or W. Rust hub parity and the OAP agent-loop work are not prerequisites for this native path.

## Open decisions and proof

A human must decide the new OAP release pin, whether to enable Codex `experimentalApi` for daemon tools, how to pass session instructions (the proposal is `developerInstructions` at open), and the default permission posture. Until tools and instructions exist, the first path serves only ordinary coding sessions. In particular, absence of an approval prompt does not prove a guard ran.

The static re-read did not prove Codex reopen after hub restart, dynamic-tool retention after resume, compatibility of the local Codex version with the adapter pin, concurrent session capacity, or estimated PR sizes. Real acceptance must cover these where relevant; synthetic tests alone cannot establish them. See [ADR 0010](../adr/0010-oap-codex-harness.md).
