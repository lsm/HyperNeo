# OAP backend: opt-in Codex plan

The 2026-11-04 re-read retains the architecture but narrows the first delivery to an opt-in native Codex harness. The intended first-step scope remains a proposal awaiting human confirmation. The status below distinguishes shipped slices from the remaining work. The re-read was a static check of source, GitHub and local files at HyperNeo `71e5a6106f` and OAP `147259e9bd`; it ran no oapx, real Codex or tests. Subsequent changes may have moved those baselines.

## Boundary and first path

The proposal is that a session explicitly selecting `harness: codex` uses native Codex app-server through `oapx serve --stdio`. A session without a harness continues on the Claude Agent SDK. ACP is not a current default path: the re-read found its runner removed. Other providers and automatic oapx download are outside this first path; the existing `anthropic-codex` bridge stays until real migration and no remaining users.

The existing `QueryLike` seam in `QueryRunner` is used instead of a second runner. Translate OAP events into SDK-shaped messages, including exactly one terminal `result`, so existing delivery, attempt and generation handling, `sdk_messages`, chat storage, web, iOS and Neo turn facts can continue to work. The existing `OapStdioClient` speaks raw envelopes, not the hub request/reply/subscription protocol, so it cannot directly send hub operations.

Engine integration belongs in daemon `lib/oap/` and `lib/agent/`. Neo core continues to know work adapters and stored messages, not OAP; the `drivers/hyperneo-adapter.ts` seam passes the harness and records provenance. The coding pack stays unchanged. A web harness selector is a later entry point, not a rewrite of the clients.

## Identity, recovery and limits

Use the HyperNeo session ID as OAP `session_id` and store the Codex thread ID in existing `sessions.sdk_session_id`; add no identity table or column. Pass `--session-history` so the hub can persist its bindings. When a native ID exists and the adapter supports `session.open.reopen`, reopen using Codex `thread/resume`. The planned summary fallback permits a new session only for `unknown_session` or `unsupported_feature` specifically for reopen, with a visible notice; infrastructure errors must surface without fallback. That fallback is not yet wired: #10152 persists a notice and stops when the binding is missing or unsupported. #10150 preserves the refused feature identity so unrelated unsupported features cannot trigger fallback. Recovery never automatically replays a run or its tool side effects. Codex reopen across a hub restart still requires a real acceptance journey.

The initial design excludes sessions with `toolGuards`, `workerOperations`, Space workflows or Neo root work: native Codex does not run the existing `PreToolUse` guard, and daemon tools and HyperNeo session instructions are not yet available. The proposed permission posture is `on-request` with `workspace-write`, subject to the decision below. Reject stale-attempt requests; unanswered requests wait, and pending requests after daemon restart count as denied. Codex uses its own login; configuration passes only allowlisted environment variable names, not keys.

A hub exit fails pending requests once, makes affected sessions idle and surfaces a notice; the next message can reopen. A Codex exit yields one error terminal. Only `busy` is eligible for automatic retry; reconnecting a subscription does not replay commands. Discard late events by attempt. Reject a binary with a mismatched version or checksum without affecting SDK sessions. Surface upstream limits rather than stacking SDK retries.

## Delivery lanes

Status checked against HyperNeo `dev` at `8a31d97b0f` on 2026-11-07. The S slices, W1, W2 and W3 have merged, along with the first reopen slice; real Codex acceptance remains unverified. Dependencies describe the plan, not evidence that later work has shipped. Estimates and concurrency are not measured guarantees.

The original W2 was split: **W2a** (#10136) merged guarded session admission with SDK default; **W2b1** (#10144) merged the query-to-hub transport; **W2b2** (#10146) merged production workspace wiring. W2b2 validates explicit binary configuration, uses one transport per workspace, refuses unsafe history replacement and does not automatically resend a failed turn. Its daemon proof used a synthetic Codex peer, not a live Codex login or model.

**W3** (#10148) records submission before the hub call, acknowledges matching acceptance and binds output, cancellation and terminal delivery to the owning attempt and generation. **W4a** (#10152) persists the native thread ID and reopens it after a hub restart; the observed restart proof used a synthetic peer. Missing or unsupported bindings yield a persisted notice and stop; summary fallback is W4b, still to be implemented. #10155 initially refused unsafe context clears; #10159 superseded that refusal with a persisted clear intent and a fresh native thread, including recovery after interruption. Real Codex login, model acceptance and native reopen remain unverified.

Upstream OAP [#1684](https://github.com/lsm/open-agent-protocol/pull/1684) merged at `4b6bf2c8d3`: a named stdio open may elect an absolute existing directory for an `any_directory` adapter, preserves the host session ID, persists placement, and refuses conflicting or unavailable reopen placement. Fixed-adapter elections are rejected. This is a stdio open binding, not a general claim that every transport accepts a fresh directory election; the upstream proof used synthetic Codex peers. HyperNeo W2b2 uses that capability per workspace.

| Lane | Scope | Dependencies |
| --- | --- | --- |
| S1 | Hub codec and owned subprocess client (#10095, #10102) | Merged |
| S2 | Text, terminal, tool, thinking and usage translation (#10114, #10130) | Merged |
| S3 | Inject the `QueryLike` factory; build `OapQuery` (#10088, #10128) | Merged |
| S4 | Harness selection with SDK default; reopen decision (#10094, #10126) | Merged; W4a wires reopen, W4b fallback remains |
| S5 | Explicit binary version/checksum check and hub configuration (#10089, #10127) | Merged |
| S6 | Map permissions and user questions (#10119) | Merged; mapping alone does not prove guards |
| W | W1 hub lifecycle (#10134), W2 and W3 merged; W4a reopen merged, W4b fallback remains | W1: S1b, S5a, S5b; W2: W1, S2a, S3a, S3b, S4a; W3: W2; W4: W2, S4b |
| P | Wire permission prompts, then prove approval, denial and guard exclusion in a real run | P1: W3, S6a; P2: P1 |
| M | Map models; add session harness selector | M1: W2; M2: S4a and avoid conflict with settings PR #10078 |
| N | Pass harness through the HyperNeo driver and verify provenance and real Codex turn facts | W3, M2 |
| E | Engine status and harness-tagged failure classification | E1: W1; E2: W3 |
| T | Connect daemon operation handlers as client tools and prove a real Neo operation | OAP O2b → T1 → T2 |

The upstream O1 instruction decision and implementation precede O2b client-tool implementation; O2a independently checks whether `thread/resume` retains dynamic tools. O2b also depends on the client-tool decision. The W4a proof used oapx alpha.31 built from OAP `4b6bf2c8d3`; a suitable release pin and live Codex acceptance remain decisions and proof work. Rust hub parity and the OAP agent-loop work are not prerequisites for this native path.

## What this revision drops from the old plan

The earlier plan proposed a provider-by-harness rollout, a 26-PR list, and a “Decisions for the human” table, including planned GLM, Kimi and DeepSeek moves. This revision does not carry those rollout commitments forward. Whether the first OAP step is only opt-in Codex requires a human answer before Jason reviews this proposal.

## Open decisions and proof

A human must decide the new OAP release pin, whether to enable Codex `experimentalApi` for daemon tools, how to pass session instructions (the proposal is `developerInstructions` at open), and the default permission posture. Until tools and instructions exist, the first path serves only ordinary coding sessions. In particular, absence of an approval prompt does not prove a guard ran.

The static re-read did not prove Codex reopen after hub restart, dynamic-tool retention after resume, compatibility of the local Codex version with the adapter pin, concurrent session capacity, or estimated PR sizes. Subsequent synthetic-peer journeys exercised hub restart and reopening; they did not prove native Codex reopen. Real acceptance must cover these where relevant; synthetic tests alone cannot establish them. See [ADR 0010](../adr/0010-oap-codex-harness.md).
