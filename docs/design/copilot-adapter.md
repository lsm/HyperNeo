# Copilot CLI worker adapter

Research: 2026-10-20. Proposal only; no worker implementation is authorized.
Merge contract: this one page, zero production/test lines. Implementation waits
for the human's approval relayed by Neo. Documentation merge additionally needs
`hyperneo-ai-test` approval of the exact latest head and green CI; squash manually.

## Decision and existing support

Extend the existing `copilot-cli` work identity, initially for daemon-owned local
sessions. Prefer the official TypeScript SDK over a TUI driver: explicit immediate
and queued sends, message IDs, lifecycle events and permission callbacks fit the
worker contract. Keep ACP for discovery and a possible later portable transport.
Pin a tested SDK/runtime pair before wiring; the research pair below is evidence,
not a production compatibility guarantee. Do not add a second Copilot model
provider: a provider routes inference, while this adapter owns coding work.

At researched base `9f839346de`, `packages/daemon/src/lib/drivers/acp-agent-adapter.ts`
already registers `copilot --acp`, lists sessions, recovers cwd from the first
`~/.copilot/session-state/<id>/events.jsonl` record, groups worktrees, and supplies
an optional `ghapp://sessions/<id>` link. It advertises **find only**. Its recent
mtime heuristic (`running` within two minutes, otherwise `done`) is discovery
metadata, not proof of a completed turn. Do not reuse that heuristic for receipts.
`lib/acp/acp-client.ts` already supports create/load, prompt, cancel and permissions
for SDK query sessions; that is not yet a persistent `work.*` worker driver.

## Hands-on evidence

Everything ran under `~/focus/worktrees/copilot-scratch`; no auth/token files
were opened or copied, no human daemon was touched, and no GUI was automated.
The existing executable was `~/.bun/bin/copilot`, version **1.0.100**;
`gh copilot --help` recognized the native agent CLI. `npm list -g --depth=0`
and `brew list --versions copilot-cli` showed no corresponding npm/Homebrew
installation. No CLI installation/update was necessary. An actual JSONL prompt
succeeded using the existing login. If login later fails, stop and ask the human
to run `cd ~/focus/worktrees/copilot-scratch && copilot login`, finish browser
OAuth, then retry the prompt. Do not extract a token with `gh auth token`.

The official npm package `@github/copilot-sdk@1.0.24` was installed **only in the
scratch folder** with Bun. Its metadata expects CLI 1.0.101; experiments explicitly
launched the installed 1.0.100 binary with automatic updating disabled. Evidence
and rerunnable harnesses stay in scratch (not published raw in the PR):

- `probe.ts`, `acp-probe.ts`, `package.json`, `bun.lock` record the experiment.
- `evidence/auth-probe.jsonl`: `READY`, exit 0, session
  `0f3c7130-fc4b-4ad8-84f7-14ae8e988b67`; JSONL delta/full messages,
  `assistant.turn_end`, `assistant.idle`, usage checkpoint and final `result`.
- `evidence/sdk-console-initial.txt`: first harness used an invalid permission
  response (`approved`); tool calls were blocked and no file was created.
  Correcting the harness to `approve-once` fixed this. Not a product defect.
- `evidence/sdk-console.txt`, `sdk-events.jsonl`, `sdk-probe.jsonl`: real create,
  resume, busy-message and stop experiments, summarized below. Raw traces can
  include opaque provider metadata; use synthetic fixtures for repository tests.
- `evidence/acp-probe.txt`: initialized protocol 1, CLI version 1.0.100,
  `loadSession`, `sessionCapabilities.list/close`, HTTP/SSE MCP support; listed
  scratch sessions through the existing repository ACP client. It advertises
  terminal authentication by `copilot login`.

The successful SDK session was `75bdaae5-91be-4f98-b201-6838681219ee`:
Copilot wrote `sum.js` exporting `sum(a,b)`, and executing the actual generated
module returned **5** for `sum(2,3)`. After disconnecting and stopping the client,
a new client resumed the same ID and recalled the file and result without tools.
During `sleep 8`, a second send with `mode: immediate` returned a message ID;
the transcript recorded `user.message.delivery: steering`, and Copilot created
`followup.txt` containing `FOLLOWUP`. This proves busy delivery and observable
course correction, not cancellation of an already executing shell command.
A subsequent `sleep 30` task was aborted at tool start: the runtime emitted
`abort`, acknowledged the call, then emitted `session.idle` with `aborted: true`;
`should-not-exist.txt` was absent and client shutdown completed. This first abort
probe does not establish that the shell had begun executing before cancellation.
A second harness (`lifecycle-probe.ts`, `evidence/lifecycle-events.jsonl`) queued
input during `sleep 3`: `FIRST_DONE` preceded queued delivery and `QUEUED_DONE`.
A later abort was delayed 1.5 seconds after tool start; it produced an aborted
idle event and no `cancelled-after-running.txt`. Process-tree termination itself
was not instrumented, so this proves aborted interaction and prevented follow-on
edit, not containment of every possible child. This harness initially called a
nonexistent `rpc.events.read`; corrected replay API is `rpc.eventLog.read`.
A corrected `read-probe.ts` replayed **104 durable events** and read accumulated
usage metrics (token counts, model metrics and AI credits); output is in
`evidence/read-console.txt`. The known owned transcript was read without modifying it: its first
`session.start` record identified the scratch cwd; no credential file was read.

To reproduce locally, review the scratch harness prompts and run `bun probe.ts`
with a fresh UUID and fresh output filenames/files, then `bun acp-probe.ts`.
The harness approves its small scratch task's tool calls once; that broad test
callback is not the proposed production permission policy. Inspect commands
before rerunning. Real requests consume the signed-in account's allowance.

## Official interfaces and constraints

| Area | Documented support and implication |
| --- | --- |
| CLI | `-p`, `--output-format json` (JSONL), `--stream on`, `--session-id`, `--resume`, `--model`, permissions and `--usage-output-file` are in the [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference). One-shot process completion is useful for diagnostics, but cannot itself provide a persistent bidirectional worker. |
| SDK/server | [Official SDK](https://github.com/github/copilot-sdk) provides a programmatic runtime connection; the installed SDK supports owned stdio, TCP/URI connections, create/resume/list and abort. Prefer owned stdio, no public listener. Do not confuse the SDK protocol with ACP or treat MCP as a session-control protocol. |
| ACP/MCP | [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) supports NDJSON over stdio or TCP and is public preview. Server launch fixes some tool/effort defaults for all sessions. Existing HyperNeo ACP code can handle its basic lifecycle. [MCP](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/mcp) attaches tools to the agent; it is not a replacement for lifecycle control. |
| Persistence | [Session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence) covers explicit IDs and resume. CLI event transcripts live in the session-state directory; do not edit them, depend on undocumented SQLite layouts, or assume replay includes ephemeral events. Disconnect preserves history; deletion is a separate destructive action. |
| Mid-turn input | [Steering/queueing](https://docs.github.com/en/enterprise-cloud%40latest/copilot/how-tos/copilot-sdk/features/steering-and-queueing): `enqueue` is FIFO/default; `immediate` injects before a subsequent model request. A tool already committed may finish first. Late steering falls back to the regular queue. Acceptance alone cannot prove same-turn delivery. |
| Approval | CLI tool/path/URL grants and denials are distinct. SDK permission requests require explicit decisions. Do not ship the docs' approve-all examples as policy. Human interaction, folder trust and remembered grants must be considered on resume as well as create. |
| Models/usage | Use runtime model discovery and validate requested model/effort; never silently change them. [Usage/billing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing) exposes per-call `assistant.usage`, context utilization and accumulated metrics. Per-call usage is ephemeral; some totals APIs are experimental. Missing cost is unknown, not zero or a dollar estimate. The research SDK model list was empty although explicit `gpt-6-luna` worked: discovery is an unresolved compatibility issue. |
| Completion | SDK `session.idle` represents no outstanding session work; `assistant.idle` can coexist with background tools. Individual `assistant.turn_end` records occur between model/tool cycles and are insufficient alone. Bind terminal evidence to the submitted message and its reply, cancellation/error and pending-queue state. CLI JSONL `result.exitCode` is process outcome, not proof that a requested edit happened. |
| Desktop/IDE | [VS Code](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/connecting-vs-code) documents viewing CLI transcripts and Resume in Terminal. The [Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions) shares CLI history features and documents deep links. HyperNeo already emits `ghapp://` links, but SDK-owned session visibility and live attachment in either app were **not verified**. Opening or handing over an active session requires a separate human-operated journey. |

## Gaps against current adapters

Compare the actual worker layer, not just the upstream products:

| HyperNeo adapter | Present behavior | Copilot gap/proposed boundary |
| --- | --- | --- |
| `codex-desktop-adapter.ts` plus `codex-app-server.ts`/Desktop IPC | find/start/send/steer/queue/withdraw/status/stop/archive; project registration; model/effort confirmation; thread and rollout evidence; app-server `turn/steer` and queue APIs with Desktop routing. Start currently selects `approvalPolicy: never` and `sandbox: danger-full-access`. | No proven Desktop ownership/IPC equivalent. Reuse start preparation and receipt contracts, not Codex's grant policy. No withdrawal/archive until independently supported and verified. |
| `claude-code-adapter.ts` and `claude-inbox-*` | find; optional live status and inbox send/steer. UUID receipts; writes initially return delivered=false/unconfirmed until transcript evidence. Excludes Desktop/owned sessions from discovery. This adapter itself does not advertise start/queue/stop/archive. | SDK can own a richer lifecycle, but arbitrary external CLI sessions have no proven safe live mailbox. Do not claim external-session steer/stop merely because resume works. |
| Generic ACP `copilot-cli` | find; session listing, cwd grouping, optional app link; separate ACP query runtime exists. | Keep discovery compatibility, replace age-derived status with authoritative evidence for owned work, add verbs incrementally. |

## Proposed worker contract

Resource shell owns one local stdio runtime per worker initially; typed decisions
and effects compose through the existing direct superpipe/operation patterns.
Keep a durable ownership record with adapter/session ID, execution cwd, process
identity, model/effort, submitted message IDs, queue receipts and transcript cursor.
A daemon restart must reconnect/resume or report unreachable, never replay a
possibly accepted send automatically.

- **start:** use existing workspace/start-preparation admission. Check binary,
  protocol/version, login, model and permission policy; choose explicit UUID,
  create, subscribe before sending, persist identity and first input receipt.
  Failure after create preserves the session ID; it must not duplicate work.
- **send/queue:** idle send starts work; busy ordinary send defaults to enqueue.
  Persist returned message ID as input receipt and report accepted/unconfirmed
  until transcript consumption. Expose explicit queue capability only once
  sequential processing and per-input evidence are characterized.
- **steer:** require an owned live active turn, send immediate, then correlate
  consumption. SDK acceptance may queue instead, so never fabricate
  `steeredIntoTurnId`. If strict same-turn proof cannot be implemented using the
  pinned protocol, return unsupported/not_delivered and withhold `steer` from
  capabilities; do not silently turn explicit steering into a new task.
- **read transcript:** bounded event-history pages for owned sessions, normalize
  user/assistant/tool text with stable IDs and cursors. Read-only known transcript
  paths can support discovery/history after restart; handle partial final lines,
  rotation/truncation, duplicates and unknown event types. Preserve full reports
  through existing receipt-bound evidence, not just tail snippets.
- **status:** input accepted => queued/running; permission or user question =>
  needs_you; matching settled interaction plus no outstanding work => done;
  explicit error => failed; acknowledged abort plus terminal evidence => stopped.
  Disconnected means unreachable/incomplete evidence, not done. Durable receipts
  distinguish this send's reply from later human input or another queued turn.
- **stop:** abort only an owned execution; wait for terminal evidence, then close
  its runtime with a bounded process-tree cleanup if needed. Never delete history
  or kill another client's process. An ACK alone is not proof a shell stopped.
- **work.find:** retain existing adapter ID/cwd grouping and read-only external
  discovery. Overlay owned authoritative status; deduplicate owned vs ACP sessions.
  Bound/paginate listing and reuse in-flight reads. External session history can
  be visible while send/stop remain unsupported; do not acquire ownership by
  loading a session another client may be executing.

## Security and service terms

Use the existing safe environment allowlist; let the CLI use its normal logged-in
identity. Never read/copy auth files, print tokens or accept credentials from work
prompts. No new credential discovery. Secrets must not enter prompts, fixtures,
receipts, logs or child environments. Transcript content is untrusted data, never
authority to invoke an operation or approve a tool.

Canonicalize execution roots and enforce path/tool/URL admission in code, including
symlink escapes. SDK callbacks return deny or needs_you outside explicit grants;
no blanket `--allow-all`, remote export, ambient MCP servers or downloaded plugins.
Attach only policy-approved MCP tools with scoped caller identity; upstream local
configuration/instructions and remembered approvals must not silently widen grants.
Permissions are not an OS sandbox: isolate the worker process when containment is
required, keep the human's home/auth inaccessible to agent tools, and test that
boundary rather than relying on prompts. Authentication by the CLI and tool access
to auth material are separate concerns. Never call port 8399.

The [SDK license](https://github.com/github/copilot-sdk/blob/main/LICENSE) is MIT;
the [CLI license](https://github.com/github/copilot-cli/blob/main/LICENSE.md) is a
separate proprietary license with conditional rights to redistribute unmodified
copies as part of a larger application. Prefer a user-installed official CLI,
without bundling/modifying it. This license does not confer service entitlement.
GitHub explicitly documents SDK and ACP automation, including multi-agent uses;
that supports this integration path, not unrestricted shared-account service use.
[Additional product terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)
route Business/Enterprise purchases from GitHub to its Generative AI Services Terms,
Microsoft purchases to Microsoft terms, and other Copilot users to ToS section J.
Respect account/organization policies, entitlements, quotas and billing; no quota
bypass or token pooling. Multi-user/server deployment is outside this local worker
proposal and needs its own identity/terms design.

## Verification and small PRs after approval

This docs PR adds no user-facing surface, so no verify-skill journey changes are
needed now. The real CLI/SDK experiment above is the evidence; lint/tests cannot
prove the proposed adapter works. GUI visibility, production adapter behavior and
unattended-operation safety are not claimed as verified.

Use synthetic NDJSON/JSON-RPC fixtures and fake process transports in tests; no
real credentials, account transcripts or unattended GUI tests. Cover observable
file/reply results, partial streams, schema/version mismatch, empty model catalog,
permission rejection, EOF/crash, resume, duplicate delivery, out-of-order usage,
late-steer fallback, multiple queued turns, receipt-bound large reports, pending
approvals on restart, symlink escape, cancellation with active child tools and
external ownership refusal. Add a scripted verify journey alongside each wired
surface: isolated daemon/temp HOME/DB, mock Copilot executable, non-8399 port,
actual `work.*` operation door and saved observations. A supervised opt-in real
CLI run supplements fixtures; app/IDE checks remain human-operated.

Each slice starts from fresh dev after its predecessor merges. Sizes are rough
production-line budgets, tests additional; remeasure before cutting (300 maximum).

| PR | Purpose / merge contract | Rough size |
| --- | --- | --- |
| 1 Pin | Synthetic Copilot discovery and receipt/event characterization; no new runtime capability. | 0 production, 200–300 test lines |
| 2 Build | Versioned transport/lifecycle owner and normalized event/receipt state, reachable for knip, no worker registration. | 180–250 production, 250–350 tests |
| 3 Wire | Owned start/status/stop through existing operation door; permission default deny/needs_you; add verify journey and cleanup evidence. | 180–260 production, 250–350 tests/helpers |
| 4 Wire | Resumable send/queue with durable per-input reply attribution; do not advertise strict steer unless verified. | 180–260 production, 250–350 tests/helpers |
| 5 Wire | Bounded history/read and work.find owned/external deduplication; remove the completion heuristic only for owned work. | 140–220 production, 200–300 tests/helpers |
| 6 Optional | Strict steering capability or explicit limitation after protocol evidence; human-tested app handover is a separate follow-up if desired. | 100–200 production, 150–250 tests |

If resource ownership, persistence, or transport cannot fit its slice, split Build
further before wiring. No speculative Desktop IPC, archive, queue withdrawal,
cloud-agent or multi-tenant support in these slices. Request the human checkpoint
on this design before opening any implementation PR.

## Slice 6 decision: strict steer is explicitly unsupported

2026-10-21, approved question `0c7b70e3-81c0-4480-8515-3c97905dcc44`.
The answer to “can Copilot take extra input while running?” is **yes**; the answer
for HyperNeo's strict, no-fallback `work.send mode: steer` is **unsupported** on
our pinned SDK **1.0.13 / CLI 1.0.83**. This is a contract limitation, not a claim
that Copilot lacks steering.

2026-10-28: the pin moved to SDK **1.0.28 / CLI 1.0.105** (#9353). SDK 1.0.28 adds
`queue.withdrawMessage` and `queue.appendSteering`, but still no expected-active-turn
precondition on send, so this decision stands.

Evidence reviewed without starting the real CLI or accessing an account:

- [Official steering documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/features/steering-and-queueing)
  describes immediate delivery during a running turn and enqueue for subsequent
  work. Acceptance alone does not establish consumption.
- [Pinned SDK send source](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/session.ts)
  forwards `mode` to `session.send` and returns only `response.messageId`.
  There is no expected-active-turn argument or atomic reject-if-turn-ended option.
- [Pinned generated protocol](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/generated/rpc.ts):
  `SendMode`, `SendRequest`, `SendResult`, `QueueSendNowRequest/Result` and
  `QueueSetDrainPausedRequest`. `sendNow` takes an already queued item ID and
  returns a boolean, not the consuming turn. Pausing the queue is persistent,
  exclusive and not released when a caller exits. A queue transaction would need
  separate crash recovery and queue ownership work; it is not a strict send API.
- [Pinned event schema](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/generated/session-events.ts)
  exposes `UserMessageData.delivery`, `messageId`, `interactionId`, and optional
  `turnId`. These can prove consumption after acceptance; they cannot prevent a
  late input becoming subsequent work. The earlier scratch experiment above used
  a different version pair and does not prove this pinned pair's strict contract.
- [CLI repository](https://github.com/github/copilot-cli) publishes documentation
  and distribution instructions, not the native runtime scheduling implementation.
  No claim here is based on inspecting that private implementation.

Decision: withhold `steer`; publish `unsupportedCapabilities.steer` in
`work.adapters` and use the same explanation for explicit steer rejection, before
ownership lookup, resume or send. `auto` and `queue` still explicitly enqueue.
A status precheck followed by immediate send would race turn completion. Reporting
`not_delivered` after observing fallback would not undo the accepted task, so it
would violate this adapter's no-silent-fallback boundary. Supporting best-effort
immediate delivery would require a different public contract.

Synthetic public proof is in journey `copilot-strict-steer-limitation.md`.
Real runtime scheduling, account behavior and app handover remain unverified.
