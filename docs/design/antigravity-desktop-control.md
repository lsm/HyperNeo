# Antigravity Desktop control

Research: 2026-11-27 on mini6, Antigravity 2.35.2. Proposal only.
Merge contract: this page and its evidence file, zero production/test lines.
Slices follow as separate issues and PRs (send, stop, history), each about 300
production lines with tests, each proven with the verify skill.

## Decision

Extend the existing `antigravity-desktop` work adapter
(`packages/daemon/src/lib/drivers/antigravity-desktop-discovery.ts`, find only
since #11597) with send, stop and turn history. Talk to the language server the
running app already starts, over its local Connect JSON API, the way Copilot
Desktop control talks to the app's advertised WebSocket
(`copilot-desktop-channel.ts`, `copilot-desktop-control.ts`,
`copilot-desktop-adapter.ts`). Do not drive the GUI, and do not start a second
language server: the conversation, its model settings and its live turn state
belong to the app. Keep `antigravity-cli` (ACP over `agy`) unchanged; it owns
CLI conversations and already skips Desktop ids.

## How the app is reached

- The app runs `Resources/bin/language_server --standalone ... --https_server_port 0`
  and reads its host bridge token from stdin, so the command line has no secret.
- It advertises itself in `~/.gemini/antigravity/daemon/hub_<httpPort>.json`
  (mode `0600`, owner only): `pid`, `httpsPort`, `httpPort`, `lsVersion`,
  `csrfToken`.
- `httpPort` serves `POST /exa.language_server_pb.LanguageServerService/<Method>`
  with `content-type: application/json`, `connect-protocol-version: 1` and header
  `x-codeium-csrf-token`. A missing token returns `401 missing CSRF token`, a
  wrong one `401 invalid CSRF token`.
- The app's own `agentapi` helper (`~/.gemini/antigravity/bin/agentapi`) uses the
  same server through `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`.

The channel reads the advertisement with the same private-file checks Copilot
uses (regular file, owned by us, no group or other bits, `O_NOFOLLOW`, size cap),
then checks with `lsof` that `pid` owns the `127.0.0.1:httpPort` listener.
Several `hub_*.json` files, a stale pid or a foreign listener all mean
"unavailable". Control is advertised only while this check passes; otherwise
the adapter stays find only with the existing hint. The token is held in memory
for one call and never logged, stored or returned.

## Operations

| Work capability | RPC | Request | Observed result |
| --- | --- | --- | --- |
| `send` | `SendUserCascadeMessage` | `{cascadeId, items:[{text}]}` | `200 {}`; a new `USER_INPUT` step, then `PLANNER_RESPONSE` `GENERATING` |
| `stop` | `CancelCascadeInvocation` | `{cascadeId}` | `200 {}`; the running `PLANNER_RESPONSE` becomes `CANCELED` |
| `turns` / `readTurns` | `GetCascadeTrajectorySteps` | `{cascadeId, stepOffset}` | ordered steps with `type`, `status`, `metadata.createdAt`, `userInput.userResponse`, `plannerResponse.response`, `errorMessage.error.shortError` |

Target admission: the id must match `^[\w-]{1,128}$` and resolve through the
existing catalog read (desktop rows only, top level, `source = ''`), so a send
can only reach a conversation discovery already shows. Unknown ids return
`not_found`. A transport failure returns `unreachable` with a retryable hint.

`send` returns `delivered: false` with a receipt `{executionId: cascadeId,
inputId: <client id>}`. The send response is an empty `{}`, and the server may
hold a message back (see the evidence: a send into a retrying conversation
appeared only after the retry finished). So the slice sets the request's
`clientMessageId`, and `status` reports the receipt `observed` only once a
`USER_INPUT` step with that text appears, the way Copilot confirms
`observedInput`. The send slice confirms with a probe that the step echoes the
client id; if it does not, it matches on the first new `USER_INPUT` after the
step count read before sending. When the last step is still `GENERATING`, the
send is rejected as `busy`. Steer and queue are out of scope.

`stop` succeeds only when a step was `GENERATING` or `RUNNING` before the call,
and it reports `stopped: true` once that step reads `CANCELED`.

History maps steps to turns in step order, not `createdAt` order (a held-back
message keeps its earlier `createdAt`). Each `USER_INPUT` opens a turn, and the
next `PLANNER_RESPONSE` closes it. An `ERROR_MESSAGE` marks the turn failed but
does not close it, because the server may retry it. Tool steps stay inside the
turn as counts only. Paging uses `stepOffset`.

## Slices

1. **Send.** Covers the channel (advertisement, owner check, one Connect call
   with timeout), `send` in a new `antigravity-desktop-control.ts`, control
   capabilities on the adapter, and the wiring in `family-operations/drivers.ts`.
2. **Stop.** Covers `stop` in the control module, and capabilities.
3. **History.** Covers `turns`, `readTurns` and `status` from trajectory steps,
   in `antigravity-desktop-history.ts`.

Each slice:

- Adds unit tests against a fake local Connect server: no app needed. The tests
  include token and owner rejections.
- Adds a verify journey that drives a real Desktop conversation through
  `work.send`, `work.stop` and `work.read` on an isolated daemon.

Out of scope:

- Start, rename, archive, steer, queue and compact.
- Windows and Linux paths.
- HTTPS (`httpsPort`).

## Evidence

[antigravity-desktop-control-probe.txt](../../.claude/skills/verify/evidence/antigravity-desktop-control/probe.txt)
holds the probe output.

- One conversation was created with `agentapi new-conversation --model=flash`,
  then sent to, read and stopped through the API above.
- The token and account fields are redacted. The probe printed neither.
- A first probe used `--model=flash_lite`. Its turn failed with a server-side
  `503 No capacity available for model gemini-3.5-flash-lite`. A send into that
  conversation returned `200 {}`, and no new step was visible 12 s later. A
  minute later, the server had retried the turn and then run the held-back
  message. So the empty reply means "accepted", not "delivered", and turns are
  ordered by step index.

## Risks

- **The API is internal and unversioned.** `lsVersion` is in the advertisement,
  so slices validate every response with zod and turn a shape mismatch into
  `unreachable`, never a crash.
- **The catalog may not be visible while the app writes it.** A bare
  `bun:sqlite` read-only open fails while the app is running and its WAL is
  non-empty. The repo's `readAntigravityDesktop` still lists both probe
  conversations in that state (see the evidence), so target admission can rely
  on it. Each journey re-checks this with the app running.
