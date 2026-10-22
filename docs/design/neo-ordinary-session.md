> Execution update (human, 2026-10-21 20:51 and 20:55): the P0–P20 ladder below
> is superseded. #8114 deletes the Neo runtime and automatic turn-end reply in
> one deletion-first PR; the consecutive follow-up adds optional replyTo to
> publication/question tools. Only human Neo conversation writes prefix their
> message id; shared delivery headers and session-message text stay unchanged.
> replyTo accepts only human messages in that Neo conversation. No receipts,
> versioned references, migration framework or client compatibility phases are
> part of this replacement plan. The historical inventory below remains evidence.

# Neo is an ordinary session

Status: proposed; implementation requires human approval. This PR changes documentation only.
Source audit: HyperNeo `162f5d1b0efc9b645d4e91738ef2360da0e54f2d` and neo-ios
`1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14`. Links below pin those revisions;
line numbers must be re-audited against fresh dev before each implementation slice.

## Decision

The human's rule, 2026-10-21 16:00:

> The Neo session can't differ from other sessions in any way. It is an ordinary
> session; only its prompt and MCP tools may differ. Message delivery is too
> important to special-case.

Delete the Neo-only input runtime. Root Neo uses the same durable mailbox,
message-delivery jobs, session admission, live prompt iterator, consumption
record, interruption and recovery as any other session with the same settings.
The existing `neo:` ID and binding remain stable identifiers for its prompt,
MCP operation authorization and public conversation, never delivery selectors.
There is no replacement coordinator, holder, delivery flag, batching timer or
Neo-only startup gate. A prompt may instruct Neo to combine answers; the daemon
must still deliver every input normally.

The daemon owns transport and consumption. Neo owns what it says it answered,
asked about or turned into work. A read without an explicit response stays
**Read, not answered**. A todo is not a reply or proof of completed work.

## Why this replaces the recovery-UUID fix

An ordinary query keeps pulling its shared message generator. Neo instead creates
`NeoCoordinatorTurn` on every query, replaces its MCP server with a turn-bound
server, binds one kickoff input, marks the feed spent, then waits for that turn
or pulls a second steer-only iterator. See [packages/daemon/src/lib/agent/query-runner.ts:881](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L881),
[packages/daemon/src/lib/agent/query-runner.ts:2203](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2203) and
[packages/daemon/src/lib/agent/query-runner.ts:2276](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2276). A separate success callback
starts a successor query ([packages/daemon/src/lib/agent/agent-session.ts:438](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L438)).

#7777 repaired teardown and recovery around this machinery. Today's recovery
job `91cde027-0043-40b8-90fe-2aca1d0251f7` reached `query_ready`, generation 2,
after the 19:18Z deployment restart, then renewed its lease while Neo was idle
and later inputs accumulated. The recovery lead was reproduced: replaying a
previously seen SDK UUID after restarting the isolated daemon produces no second
model request. The Neo feed has already been marked spent, while the admission
timeout waits for that query promise to settle
([packages/daemon/src/lib/agent/agent-session.ts:3069](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3069)). Terminal-result teardown
cannot help a replay that produces no terminal result.

The human reported a third post-restart stall on 2026-10-21: after the 22:31Z
deploy restart, job `2a5fb437` (`origin: space_inject`) reached `query_ready`,
generation 1, then renewed its lease every 100 seconds while Neo was idle, with
four inputs behind it. `client.interrupt`, with #8069 merged, preserved those
inputs but did not release the job. Only the 22:35Z daemon restart cleared it;
all four inputs were consumed within 20 seconds. These incident facts are
human-reported, not a new local reproduction.

The spent-turn admission wait is a code-confirmed unbounded decision: it arms
its timeout only in `spentTurn.catch(...).then(arm)`. If the query promise never
settles, neither does that timeout start. See
[packages/daemon/src/lib/agent/agent-session.ts:3069](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3069)
and [packages/daemon/src/lib/agent/agent-session.ts:3089](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3089).
This explains how admission can remain at `query_ready` despite continued lease
renewal; proving which promise was retained in this third incident still needs
the synthetic scenario below. Delete this wait in the **first implementation
slice**, before schemas, clients or the rest of the holder removal. Do not
introduce a new timeout/watchdog: make the existing ordinary admission deadline
unconditional on the spent turn's lifetime.

The retained failing reproduction is commit `423886cc4d` on
`fix/neo-recovery-uuid-replay`; no fix PR was opened for #8068. Its synthetic
RPC/real-SDK evidence is `/tmp/hyperneo-recovery-uuid-before-3/evidence/neo-recovery-uuid.json`
and runner output `/tmp/hyperneo-recovery-uuid-before-3.log`. Keep the branch
unchanged. Adopt its test and journey in the relevant approved slice, then run
it against both ordinary and Neo sessions. Removing the holder is not, by
itself, evidence that SDK replay identity is safe. If the ordinary path also
fails, repair identity/acknowledgment once in that common path, with the same
reproduction for both sessions. Do not resurrect the canceled Neo-only fix.

Incident trace: `/private/tmp/claude-501/-Users-lsm-focus-neo-ios/9a41f1c9-08da-4631-8b51-a36926b15169/scratchpad/stuck-1918.jsonl`.
This is a local evidence reference, not portable PR proof. Neither a context
usage timeout nor a long-lived lease alone proves a cause.

## One delivery path

```text
human send / session send / scheduled note
  -> shared mailbox and durable input row
  -> shared message_delivery job (session FIFO)
  -> session admission + shared query lifecycle
  -> shared MessageQueue prompt iterator
  -> shared consumption record
  -> ordinary SDK stream continues accepting inputs
```

The mailbox is a durable transport, not a Neo batching service. A job reaching
`query_ready` is not evidence that the SDK consumed it
([packages/daemon/src/lib/agent/agent-session.ts:3035](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3035)). Consumption is recorded
by the ordinary acknowledgment path
([packages/daemon/src/lib/agent/agent-session.ts:3145](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3145)); remove Neo's earlier
`markHolderInputConsumed` shortcut. Keep common FIFO, claims, context-clear
locks, admission deadlines, manual mode, explicit permission waits, provider
failure handling and durable startup reconciliation. They apply equally to all
sessions; an explicitly deferred input is not an enqueued automatic input.

An automatic enqueued input on an eligible idle session starts the ordinary
query. During a turn it enters the ordinary prompt feed, including human,
task and system inputs. During teardown or a deploy restart it remains durable
and the common lifecycle/recovery path resumes delivery without another send.
If these guarantees fail for a plain session, fix the first wrong shared
decision before migrating Neo. No periodic nudge is an acceptance criterion.

There is deliberate deferral today: Neo system notes defer when it is busy in
both the sender and mailbox admission. See inventory below. This saves an
interruption, not a documented fixed batching interval, and contributes to a
second scheduling policy. Delete it. Any user-configured batching/manual
policy must be a shared session feature, not a binding check.

## Deletion inventory

Every entry is a removal obligation, not permission to remove unrelated common
logic. Imports, context interface members and corresponding obsolete tests go
with their owner. The audit covers delivery and all consumers that would keep a
holder alive indirectly. Prompt and MCP content may remain Neo-specific.

| Current source | Delete or replace with the ordinary path |
| --- | --- |
| [packages/daemon/src/lib/agent/query-runner.ts:740](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L740), [packages/daemon/src/lib/agent/query-runner.ts:881](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L881) | `holderTurn`, construction, origin resolver and per-query isolated operation server. Use the ordinary session operation server. |
| [packages/daemon/src/lib/agent/query-runner.ts:412](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L412), [packages/daemon/src/lib/agent/query-runner.ts:415](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L415) | `promptSpentGeneration` and `acceptsPrompt`; no one-kickoff quota. |
| [packages/daemon/src/lib/agent/query-runner.ts:1074](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L1074) | `!holderTurn` exception to live MCP reconciliation. |
| [packages/daemon/src/lib/agent/query-runner.ts:1398](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L1398), [packages/daemon/src/lib/agent/query-runner.ts:1421](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L1421), [packages/daemon/src/lib/agent/query-runner.ts:1819](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L1819) | Carried-input bookkeeping, response-origin stamping, automatic turn-end publication, Neo-only SDK close and holder disposal. Preserve common SDK result handling. |
| [packages/daemon/src/lib/agent/query-runner.ts:2186](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2186), [packages/daemon/src/lib/agent/query-runner.ts:2203](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2203), [packages/daemon/src/lib/agent/query-runner.ts:2266](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2266), [packages/daemon/src/lib/agent/query-runner.ts:2273](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2273), [packages/daemon/src/lib/agent/query-runner.ts:2283](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L2283) | Holder argument/bind/pre-consumption, spent assignment, special envelope, one-input return and `feedNeoSteers`, including requeue of inputs not named by the result. Keep the single ordinary iterator. |
| [packages/daemon/src/lib/agent/agent-session.ts:370](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L370), [packages/daemon/src/lib/agent/agent-session.ts:384](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L384) | `replyAtNeoTurnEnd` and `createNeoTurnMcpServer`; explicit publications use the normal session MCP caller. |
| [packages/daemon/src/lib/agent/agent-session.ts:438](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L438), [packages/daemon/src/lib/agent/agent-session.ts:1127](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L1127), [packages/daemon/src/lib/agent/coordinator-handoff.ts:1](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/coordinator-handoff.ts#L1) | Prefix-gated query-success callback, `handoffCoordinatorInput`, entire 67-line successor-admission module. Preserve shared query liveness. |
| [packages/daemon/src/lib/agent/agent-session.ts:1793](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L1793) | Neo early return in runtime MCP synchronization. |
| [packages/daemon/src/lib/agent/agent-session.ts:3069](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3069), [packages/daemon/src/lib/agent/agent-session.ts:3089](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3089) | **First implementation slice (P0):** delete the `spentTurn` selection and `.then(arm)` timeout deferral. Use the existing common bounded admission behavior immediately, even if the prior query promise never settles. |
| [packages/daemon/src/lib/agent/agent-session.ts:3255](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3255), [packages/daemon/src/lib/agent/agent-session.ts:3272](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3272), [packages/daemon/src/lib/agent/agent-session.ts:3290](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L3290) | `steerNeoInput`, `requeueNeoInput` and `markHolderInputConsumed`. Keep shared redelivery/consumption primitives wherever other callers need them. |
| [packages/daemon/src/lib/agent/message-queue.ts:62](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/message-queue.ts#L62), [packages/daemon/src/lib/agent/message-queue.ts:441](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/message-queue.ts#L441), [packages/daemon/src/lib/agent/message-queue.ts:611](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/message-queue.ts#L611), [packages/daemon/src/lib/agent/message-queue.ts:821](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/message-queue.ts#L821), [packages/daemon/src/lib/agent/message-queue.ts:956](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/message-queue.ts#L956), [packages/daemon/src/lib/agent/query-runner.ts:419](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-runner.ts#L419) | Neo-only steer flag/admission option, `steer`, `steersUntil`, `waitForSteer`, `acceptsSteer`. Source audit finds their production consumers only in the holder feed. Preserve ordinary queue wake/stop and user steering semantics. |
| [packages/daemon/src/lib/neo/service.ts:162](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L162), [packages/daemon/src/lib/neo/service.ts:305](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L305), [packages/daemon/src/lib/neo/service.ts:325](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L325), [packages/daemon/src/lib/neo/service.ts:981](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L981) | Processing-status cache used to steer/hold delivery, both steer subscriptions and `steerQueuedInputs`. Retain UI notification responsibilities, without steering. |
| [packages/daemon/src/lib/neo/service.ts:1028](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L1028), [packages/daemon/src/lib/mailbox/registration.ts:108](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/mailbox/registration.ts#L108), [packages/daemon/src/lib/neo/session-status.ts:11](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/session-status.ts#L11) | Both binding-based system-note deferral decisions and `neoNoteDeliveryMode`. Keep shared mailbox deferral for explicitly deferred messages. |
| [packages/daemon/src/lib/neo/coordinator-turn.ts:1](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/coordinator-turn.ts#L1) | Entire 131-line class: binding/claim, human-turn flag, root-only steering, ID envelope, carried set, last-human heuristic and ended promise. |
| [packages/daemon/src/lib/neo/turn-end-reply.ts:1](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/turn-end-reply.ts#L1), [packages/daemon/src/lib/neo/response-input.ts:1](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/response-input.ts#L1) | Entire 66-line automatic reply and 45-line response-stamping modules. No result-text-to-publication inference. |
| [packages/daemon/src/lib/operations/registry.ts:20](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/operations/registry.ts#L20), [packages/daemon/src/lib/operations/invoke.ts:108](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/operations/invoke.ts#L108) | `OperationCaller.neoTurn` and its exclusive stale-mutation gate. Preserve caller role/authorization; use common attempt cancellation for every session, never recreate a Neo turn lease. |
| [packages/daemon/src/lib/neo/publication-operation.ts:120](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/publication-operation.ts#L120), [packages/daemon/src/lib/neo/publication-operation.ts:141](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/publication-operation.ts#L141), [packages/daemon/src/lib/neo/publication-operation.ts:203](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/publication-operation.ts#L203), [packages/daemon/src/lib/neo/publication-operation.ts:288](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/publication-operation.ts#L288) | Current-turn membership, kickoff producer identity, holder lifetime checks and automatic ask/producer derivation. Replace with explicit input references and normal authorized session identity. |
| [packages/daemon/src/lib/neo/ask-record-operations.ts:158](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/ask-record-operations.ts#L158), [packages/daemon/src/lib/neo/request-key.ts:4](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/request-key.ts#L4), [packages/daemon/src/lib/neo/work-origin.ts:3](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/work-origin.ts#L3) | Kickoff-derived ask origin and request keys; accept explicit origin references and caller-supplied idempotency keys. |
| [packages/daemon/src/lib/neo/operations.ts:288](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/operations.ts#L288), [packages/daemon/src/lib/neo/operations.ts:303](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/operations.ts#L303), [packages/daemon/src/lib/neo/operations.ts:608](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/operations.ts#L608), [packages/daemon/src/lib/neo/service.ts:372](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L372), [packages/daemon/src/lib/neo/service.ts:964](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L964) | Implicit human-turn source/ownership, snapshot cache key and saved-rule origin. Explicit durable references replace origin guesses; snapshot caching uses ordinary session/context revision, never a kickoff. |
| [packages/daemon/src/lib/neo/session-archive-operation.ts:26](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/session-archive-operation.ts#L26), [packages/daemon/src/lib/neo/conversation-read-operation.ts:28](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/conversation-read-operation.ts#L28), [packages/daemon/src/lib/neo/home/operations.ts:69](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/home/operations.ts#L69) | Holder lifetime/human-turn dependency in operations. Keep human-only archive/rule authority, session ownership and cancellation with explicit authorization; a read input is not human approval. |
| [packages/daemon/src/lib/neo/service.ts:339](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L339), [packages/daemon/src/lib/neo/restart.ts:44](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/restart.ts#L44), [packages/daemon/src/lib/neo/service.ts:553](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L553) | Automatic post-compaction seed delivery, restart clear-then-seed pipeline and root-only turn-limit removal. Put context instructions in the prompt and fetch current work through MCP; reset uses ordinary fresh-context behavior. |

### Other runtime exceptions forbidden by the same rule

Removing the feed while retaining these differences would leave Neo an unusual
session. Include them in the approved program, rather than declaring delivery
parity prematurely:

| Current source | Result |
| --- | --- |
| [packages/daemon/src/lib/agent/query-options-builder.ts:318](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-options-builder.ts#L318), [packages/daemon/src/lib/agent/query-options-builder.ts:575](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-options-builder.ts#L575), [packages/daemon/src/lib/agent/query-options-builder.ts:972](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-options-builder.ts#L972), [packages/daemon/src/lib/agent/query-options-builder.ts:1032](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-options-builder.ts#L1032) | Delete binding-based MCP merge, broad `restrictNeoQuery` override, permission-mode shortcut and Bash-hook exemption. Prompt/MCP selection remains declarative; standard settings and hooks run normally. |
| [packages/daemon/src/lib/neo/session-policy.ts:21](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/session-policy.ts#L21), [packages/daemon/src/lib/neo/session-policy.ts:28](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/session-policy.ts#L28), [packages/daemon/src/lib/neo/session-policy.ts:75](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/session-policy.ts#L75) | Stop choosing SDK cwd/resume paths by Neo binding. Preserve the existing SDK transcript location as ordinary persisted session/workspace metadata, then use normal path resolution. Do not move/delete historical transcripts during delivery migration. Remove query-time rewrites of tools, agents, plugins, settings sources, directories and limits; only the prompt and MCP capability contribution are exceptions. |
| [packages/daemon/src/lib/agent/agent-session.ts:589](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L589), [packages/daemon/src/lib/agent/agent-session.ts:632](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/agent-session.ts#L632), [packages/daemon/src/lib/neo/model-fallback.ts:4](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/model-fallback.ts#L4), [packages/daemon/src/lib/neo/service.ts:314](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/neo/service.ts#L314) | Remove binding-based settings lookup and fallback/alignment during runtime/idle callbacks. Ordinary persisted model/provider settings use ordinary fallback policy; Neo settings UI can edit them through the same config operation. |

`sessionSdkPath` has callers in query lifecycle, model switch, rewind, SDK message
handling, message RPC and session deletion
([packages/daemon/src/lib/agent/query-lifecycle-manager.ts:111](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/query-lifecycle-manager.ts#L111),
[packages/daemon/src/lib/agent/model-switch-handler.ts:239](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/model-switch-handler.ts#L239),
[packages/daemon/src/lib/agent/rewind-handler.ts:241](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/rewind-handler.ts#L241),
[packages/daemon/src/lib/agent/rewind-handler.ts:532](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/rewind-handler.ts#L532),
[packages/daemon/src/lib/agent/sdk-message-handler.ts:1358](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/agent/sdk-message-handler.ts#L1358),
[packages/daemon/src/lib/rpc-handlers/message-handlers.ts:90](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/rpc-handlers/message-handlers.ts#L90),
[packages/daemon/src/lib/session/session-lifecycle.ts:622](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/session/session-lifecycle.ts#L622),
[packages/daemon/src/lib/session/session-lifecycle.ts:758](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/daemon/src/lib/session/session-lifecycle.ts#L758)). Migrate every caller
before deleting that helper. Keep generic context-clear lock holders: their
name does not mean they implement the abandoned Neo holder design.

## Explicit message attribution

Expose the durable input ID and session ID to **every** session through the
common input envelope, on both kickoff and later prompts. The visible human
text/images remain unchanged. Use a transport metadata block (with an untrusted
content boundary), not a UUID that the model must invent or read from SDK
internals. `requestId` remains the send's idempotency key; resolve it to the
stored durable message UUID once. SDK attempt UUIDs are transport details and
must never become public reply references. Persist the association across
restart through the common delivery records if transport UUID remapping is
required. One envelope per input, for ordinary and Neo sessions alike.

The chosen contract is an array, including the single-message case:

```json
{"requestId":"publication-send-1","replyTo":["message-A","message-B"],"shortText":"...","fullText":"...","links":[]}
```

`replyTo` contains durable human input IDs in the caller's conversation. The
session scope is resolved by normal caller authorization; never search all
sessions for an unqualified ID. `[]` is an unsolicited update and answers
nothing. A publication with IDs is Neo's explicit claim that it answers those
inputs. `interim:true` is progress only and cannot mark an input answered;
require `replyTo:[]` for interim posts. Later final posts may name the same IDs.
No inference from producer input, trigger, text, time or the latest human turn.
An answer may refer to a consumed input from an earlier turn.

Use the same `replyTo: string[]` on `neo.question.ask` for **Asked back** and on
todo creation (`neo.ask.open` todo drafts and any direct todo-create door) for
**Became todo**. Attach links to the individual question/todo, not every sibling
sharing an ask. `askId`, `goalId` and parent work links continue to group work;
they do not imply a reply. Existing human-send `replyTo:{kind,id}` means a quoted
message/question/todo and is a separate schema; do not overload it with this
agent-authored response array.

Each operation validates references exist, are human inputs in the authorized
conversation and have the ordinary consumed record. Foreign/nonhuman/unread IDs
produce a typed rejection with no partial write. Validate and append the object
and its links transactionally. Neo chooses the IDs; the daemon validates them
without a current-turn membership restriction. Mutation retry uses explicit
`requestId` and returns the same object/links; reusing a key with different
content or IDs is rejected. Publication edits have explicit replacement
`replyTo`; a text edit alone preserves links. Revisions preserve the audit trail;
current badges reflect current non-retracted assertions, and deleting a
question/todo never deletes the fact it was created from an input.

Remove the implicit authorization coupling at the inventory's `neoTurn` consumers
before deleting the runtime. MCP role and normal session identity still restrict
Neo tools. Sensitive actions retain their explicit human authorization and
confirmed-question/hash requirements. Naming a human input, or publishing an
answer, cannot grant authority to archive sessions or edit standing rules.
General attempt cancellation must prevent stale SDK calls after interrupt/reset
for all sessions. It must not select which input a publication answers.

## Status ownership and client contract

Statuses are independent facts, not a single monotonic enum. One input may be
read, asked back and become two todos before it is answered. Return timestamps
and linked object IDs so both clients can render the same evidence. Avoid a
second Neo consumption table or a daemon-maintained answered boolean.

| Fact | Only writer / evidence | Web and iOS display |
| --- | --- | --- |
| Sending / failed before delivery | Existing client outbox / shared delivery failure | Sending, retry action or failure reason; no fabricated daemon receipt. |
| Delivered | Daemon: durable row admitted to the addressed session, not merely accepted into a remote outbox/mailbox | Delivered; if awaiting consumption, Queued is an additional transport detail. |
| Read | Daemon: ordinary session turn consumption record | Read, not answered until a final explicit answer names it. Read means consumed by the runtime, not human-like comprehension. |
| Answered | Neo: final publication's `replyTo` contains the input ID | Answered with links to every answering publication; no claim that work finished. |
| Asked back | Neo: question's `replyTo` names it | Asked back with a link to the question and its open/answered/retired state. Human answering that question does not mark the original input answered. |
| Became todo | Neo: created todo's `replyTo` names it | Became todo with links and independent todo states; completion does not synthesize an answer. |

Expose delivered/read using the existing SDK message/delivery record and a
transport-neutral projection on conversation asks. Keep delivery failure and
unknown legacy consumption distinct from a confirmed read. A retained consumed
row is authoritative across reconnects. Do not use `processing_state.messageId`
or the oldest unanswered message as a per-message read/working signal.

Web currently guesses a working input from the oldest open ask and cuts its
search after the last answered one ([packages/web/src/neo/message-status.ts:68](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/web/src/neo/message-status.ts#L68));
it also treats producer/answer/revision origins as answers
([packages/web/src/neo/public-conversation.ts:37](https://github.com/lsm/HyperNeo/blob/162f5d1b0efc9b645d4e91738ef2360da0e54f2d/packages/web/src/neo/public-conversation.ts#L37)). Replace these with the
shared receipt/link projection. Render all explicitly named reply anchors,
including multiple inputs; keep unresolved older inputs visible.

On iOS, replace the single `ChatMessage.replyTo` publication field
([Neo/Models/Models.swift:593](https://github.com/lsm/neo-ios/blob/1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14/Neo/Models/Models.swift#L593)), parser ([Neo/API/NeoAPI.swift:362](https://github.com/lsm/neo-ios/blob/1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14/Neo/API/NeoAPI.swift#L362)), and cached
single reference ([Neo/Store/OpenCache.swift:22](https://github.com/lsm/neo-ios/blob/1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14/Neo/Store/OpenCache.swift#L22)) with the versioned reply array
and receipts. Replace oldest-open/last-answered inference
([Neo/Models/MessageStatus.swift:38](https://github.com/lsm/neo-ios/blob/1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14/Neo/Models/MessageStatus.swift#L38)) and Talk's chronological fallback
([Neo/Talk/TalkProgress.swift:36](https://github.com/lsm/neo-ios/blob/1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14/Neo/Talk/TalkProgress.swift#L36)). Talk waits for a publication explicitly
naming its recording/input ID; read/asked-back/todo states remain visible while
waiting. Update all send-wait consumers, including [Neo/Store/NeoStore.swift:474](https://github.com/lsm/neo-ios/blob/1d5d3f57c5d51a2ac8994eeaa16681f76fed4f14/Neo/Store/NeoStore.swift#L474).
A disconnected/stale overlay describes freshness without erasing persisted facts.
The session's global activity indicator can still show activity, without
claiming it concerns a particular unanswered input.

## Migration and rollout

1. Add versioned response references/receipts and client decoding first. Preserve
   every existing publication's `askOrigin`, producer, IDs, sequence and revisions
   unchanged. A version-1 final publication with a valid `askOrigin` renders that
   single historical link as **Legacy reply**; it is not a new explicit answer.
   Never backfill from producer, latest ask, timing or textual resemblance. Missing
   legacy receipt stays unknown. Old question/todo origins remain legacy lineage,
   not fabricated Neo-authored asked-back/todo assertions.
2. New writes carry an explicit contract version and `replyTo` array. An omitted
   array is rejected after the writer switches, rather than falling back to holder
   origin. Version-2 `[]` must never fall back to `askOrigin`. Add an indexed link
   relation keyed by object kind/ID and session/input UUID; the publication payload
   and relation commit together. No rewrite of SDK messages or replay of old inputs
   just to populate status. Pagination must query links beyond the currently loaded
   publication page so a missing page cannot turn Answered into not answered.
3. Ship web decoding and a compatible neo-ios release before switching writers.
   Use capability/version negotiation: a client that cannot represent version-2
   refs may still send/read text, but must hide per-input answer claims and display
   an upgrade notice. Do not synthesize a single `askOrigin` for a multi-input post
   to make an old client appear current. iOS cache upgrade preserves old entries as
   legacy and refreshes receipts; reconnect and offline restore retain provenance.
4. Remove implicit reply writers and holder-dependent operation contracts; then
   remove the input runtime. Restart during this migration uses only the existing
   durable recovery scan. Consume previously held enqueued inputs by ordinary FIFO;
   do not drop them, mark them read administratively or require a nudge. Explicit
   user-deferred rows remain deferred. The context seed stops being an injected job;
   any already queued seed remains an ordinary system input and must drain.
5. Existing SDK cwd/resume metadata is pinned before removing path overrides.
   Verify resume into the same synthetic transcript, including rollback/restart.
   Roll back code only to a revision capable of reading the additive schema;
   retain references and receipts. A rollback must not restore inferred answer
   claims for version-2 rows or clear pending delivery jobs.

No new delivery service, watchdog or migration wake is introduced. The old
`neo_input_origins` lineage can remain read-only for old publications until its
remaining readers are removed; it must stop determining new reply attribution.

## Implementation slices after approval

Each row is one purpose and one PR from then-current dev, never a stack. Target
100–200 changed production lines; tests/journey scripts ride the owning slice.
These are merge-contract budgets, not promises of measured future diffs. The
current whole-module deletion counts are measured: coordinator turn 131,
turn-end reply 66, response stamping 45, successor handoff 67, request key 12,
work origin 16. Re-measure with `git diff origin/dev...HEAD --numstat`; split a row
if its actual diff exceeds 200. A necessary smaller deletion is preferable to
padding it. Follow the repository Pin → Build/Wire → Delete ladder; no mixed
construction/deletion PR. Dependencies are explicit below; no dead module is
left for knip between merges. P0 is the first production change: commit its
failing synthetic reproduction before its deletion in the same PR. No schema,
client or holder-removal prerequisite may delay it. The retained recovery-UUID
branch remains unchanged; reuse its evidence and copy/adapt the reproduction
only in the approved owning slice.

| Slice | Purpose / boundary | Production budget and gate |
| --- | --- | --- |
| P0 — first | Delete the spent-turn-dependent admission timeout deferral (`agent-session.ts:3069–3073,3089–3090`), using the existing ordinary deadline. Remove only private spent-prompt bookkeeping made unused by that deletion. Commit a failing reproduction first: deploy restart with an admission stuck at `query_ready`, an unsettled spent-query promise and four queued inputs, including `space_inject`. | About 10–20 production lines; do not pad a deletion to 100. Existing admission must settle within its normal deadline; queued inputs must reach the model without a nudge or another daemon restart. Include ordinary/Neo parity and mid-turn human checks; no green claim from timeout firing alone. |
| P1 | Pin existing SDK transcript location in ordinary persisted session metadata, using shared path resolution. | 100–150; both sessions resume the same synthetic SDK history after restart. |
| P2 | Build the versioned explicit-reference schema and indexed link persistence. | 100–200; additive migration/idempotent object+link transaction, no writer switch. |
| P3 | Build the shared input-ID envelope and read/delivery receipt projection. | 100–200; input UUID remains stable through retries/restart; no Neo binding predicate. |
| P4 | Wire common envelope/receipts through the ordinary feed and conversation read. | 100–150; ordinary and Neo requests contain identical metadata structure. |
| P5 | Build publication explicit-reference validation/write door. | 100–200; named A/B, empty refs, foreign/unread rejection and idempotent retry. |
| P6 | Build question reference write door. | 100–150; selected input linked, unrelated input unchanged. |
| P7 | Build todo reference write door. | 100–150; individual todos link selected inputs, not all siblings. |
| P8 | Wire web's versioned status/array decoding and visible links. | 100–200 per bounded component slice if needed; no runtime delivery change. |
| P9 | Wire neo-ios decoding/cache version and visible status/array links in lsm/neo-ios. | 100–200 per bounded model/UI slice; compatible release precedes writer switch. |
| P10 | Wire explicit operation schemas/prompt guidance to the new doors after both clients are compatible. | 100–200; new omitted refs reject; later-turn answers work; no old writer fallback for version 2. |
| P11 | Delete automatic turn-end replies (66-line module plus call/context plumbing), once explicit publishing is usable. | 100–150; a plain result leaves Read, not answered. |
| P12 | Remove holder dependence from sensitive-operation authorization, with common attempt cancellation/explicit human proof already pinned. | 100–200 per bounded operation family; permission tests must not weaken. |
| P13 | Remove holder dependence from publication producer/lifetime and ask origin/request keys/snapshot reads. | 100–200 per operation family; explicit references, stable request IDs, no implicit kickoff. |
| P14 | Delete obsolete attribution machinery after explicit contracts are live: response stamping (45 lines), old envelope, origin/human/last-input bookkeeping and their last call sites. Thin the still-live holder to lifecycle/steer ownership only. | 100–200; delete each method with its last call site; input metadata now comes from P4. |
| P15 | Delete Neo-only system-note deferral and seed-job injection, once generic feed delivery is pinned. Keep already queued seed inputs. | 100–150; busy system notes and the retained seed drain normally. |
| P16 | Delete the one-kickoff query branch and remaining holder shell; the already-existing ordinary iterator becomes unconditional. Include specialized terminal close and disposal. | 100–200 after P11–P14 thinning; delete the remaining class with its last construction/import. |
| P17 | Delete now-obsolete successor handoff (67) and query-success callback. The spent-timeout wait was already removed in P0. | 100–150; idle/restart inputs drain without a successor coordinator. |
| P18 | Delete steer subscriptions, Neo requeue/consumption shortcuts and steer-only queue lane together with their last consumers. | 100–200; split into caller-closure deletions before P16 if needed; never leave an unused module/private method. |
| P19a | Delete remaining query settings/tool overrides; declarative prompt/MCP contributions already use standard settings. | 100–200; matched settings yield the same lifecycle/options except prompt/MCP. |
| P19b | Delete SDK path exceptions after P1 pins ordinary metadata and every listed caller uses it. | 100–150; resume/rewind/deletion keep the same synthetic transcript. |
| P19c | Delete binding-specific settings/model fallback/alignment callbacks. | 100–150; ordinary config operation and shared fallback policy apply. |
| P20 | Delete last holder caller types, request-key/work-origin helpers and obsolete implicit attribution writers with their last consumers. | Up to 150; smaller deletion-only PR is acceptable; search audit finds no runtime holder/neoTurn/spent/Neo-steer branches. |

P12/P13 may require a small shared attempt-context build/wire prerequisite if
the existing common MCP lifetime cannot supply cancellation. That prerequisite
must be useful to all sessions and tested under interrupt/reset before deleting
the old gate. No input-origin field belongs in that context. For P16/P18, map
last callers before cutting: the ordinary feed must be unconditional in the
same deletion that removes its alternate iterator. Thin attribution first so
that whole callable closure fits 200 lines. If it does not, stop and re-slice
with measured blocks; do not evade the budget or land unused modules.

Delivery-2 owns `interrupt-handler.ts` and its destructive queued-input
cancellation fix (#8069), the merged shared startup-retry generation fix (#8075),
and its transient-connection retry generation renewal follow-up (`restartQueue:true`). This design PR does not edit those files or
that retry arm. Rebase each slice after those fixes merge. Preserve their shared
queue-preservation and generation tests; run their interrupt RPC journey as a
parity regression. Holder deletion does not authorize destructive cancellation
or removal of common network/model retry identity handling. Coordinate any
required change to that ownership boundary with Neo before touching it.

## Verification contract for every slice

Use [.claude/skills/verify/SKILL.md](../../.claude/skills/verify/SKILL.md), list
its journeys and read the owning journey. Shared environment setup stays in that
skill; behavioral steps live in the relevant journey file, never an index.
Adopt the retained recovery journey only in its approved implementation slice.
Current relevant journeys are `01-a-human-message-reaches-root-neo-which-answers.md`,
`explicit-mid-turn-answered-linking-handoff-pr5.md`, `interrupt-preserves-queued-inputs.md`
and `deferred-input-after-startup-retry.md`.
Update them as old holder semantics disappear; the current mid-turn journey's
older-turn rejection must become acceptance of an authorized consumed input.

Each slice runs an isolated daemon: `NODE_ENV=test`, fresh temporary HOME/data
dir/DB, its own non-8399 port, local scripted model through the installed SDK,
no provider keys in the environment and no real keys anywhere. Follow the
skill's synthetic DB credential setup and GitHub stub. Never copy a real DB.
Stop every daemon/mock started by the proof in `finally` and retain evidence.
No live daemon calls and no GUI automation are needed for delivery RPC proofs.

Run these repeatable user-surface checks on **both** ordinary and Neo sessions,
using the same scenario and assertions; differences are limited to prompt/MCP:

- Idle send: receipt, model-request marker and ordinary consumed record appear
  without a second input. A result alone creates no answer link.
- Mid-turn human: hold model request A open, send human B and task/system C;
  observe B/C in later actual model requests with their stable IDs. Publish
  `replyTo:[B]`; only B is Answered. Publish `[A,B]` and verify two visible links.
- Deploy restart: keep several jobs durably queued, stop/restart only the test
  daemon against its own synthetic DB/SDK history; no nudge. Observe every
  eligible marker reaching the model and leaving pending delivery. Include a
  replayed previously seen SDK UUID and the queued legacy context seed case.
- Deploy restart with an admission stuck at `query_ready` plus queued inputs:
  reproduce job `2a5fb437`'s shape with synthetic `space_inject` delivery,
  generation 1, an idle session, an unsettled spent-turn query promise and four
  inputs behind it. Observe the pre-fix admission outliving its normal timeout;
  continued lease renewal is not progress. Invoke `client.interrupt` and confirm
  queue preservation separately from releasing the stuck admission. After P0,
  observe the ordinary admission deadline actually bound the wait and all four
  markers reach actual model requests without a second restart or nudge.
  Retain RPC/job-stage/deadline/consumption evidence. A clock-only unit test or
  inputs surviving interrupt alone does not pass this restart journey.
- Interrupt and transient retry: run delivery-2's scenario at the retry limit;
  queued inputs survive and drain through the common generation. Explicit
  teardown still has its documented cancellation semantics.
- Status/lineage: read-without-answer, unsolicited publication, multi-input
  publication, question and multiple todos show only their explicitly named
  input links; human answering a question/completing a todo does not answer the
  original input. Exercise earlier-turn references and rejection rollback.
- Upgrade/reconnect: seed version-1 and version-2 synthetic objects, upgrade,
  paginate, disconnect/reconnect and restore the client cache; old askOrigin
  remains intact, empty new refs never become legacy replies, known facts
  survive freshness overlays. Render web and iOS status/link fixtures using
  repository-supported headless/component or app test surfaces; if actual UI
  rendering is unavailable, report it unverified rather than count RPC as UI proof.

Leave the scripted scenario with the slice if it is worth repeating. Keep RPC
receipts, actual model-request markers, own-DB receipt/link queries and client
render evidence under the run's `evidence/`; report exact output/artifact paths.
Unit/type/lint checks are additional gates, not substitutes for the observable
RPC/model/client result. A test that only asserts a holder method was called
cannot establish delivery parity.

### What this docs-only PR verifies

The source inventory and current client contracts were read at the pinned
revisions. The retained recovery test is a demonstrated **failure before any
fix**, not proof this design works. Its branch and evidence remain untouched.
This page introduces no executable behavior; none of the proposed delivery,
status, migration, web or iOS behavior is implemented or verified by this PR.
The existing verify skill is still runnable for current code; no step is changed
by a design-only page. Implementation slices must supply the runtime evidence.

Approval authorizes the described program, not an unreviewed bulk rewrite. This
design PR itself may merge only after Neo relays **Human answered question <id>**,
the worker verifies it with `neo.question.get`, an eligible review bot approves
the exact latest head with no failed reads, and required CI is green. Squash
manually; never auto-merge. Re-review any changed head. No production code lands
before the human approves the design. Approval of this page is not approval to
merge any later implementation head without its own tests, review and CI.
