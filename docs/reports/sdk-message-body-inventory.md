# `sdk_messages.sdk_message` statement inventory

Taken on 2026-10-20 from `packages/daemon/src` at dev 25ea27f9. Historical migrations in `storage/schema/migrations.ts` are excluded. Statement numbers are what `docs/architecture/sdk-message-body-split.md` refers to.

Paths are relative to `packages/daemon/src`. Kinds: WRITE (insert or update), READ-output (the body is returned to the caller), READ-filter (the body is used for selection), BOTH. Scopes: key (by id, uuid, rowid or seq), tail (ORDER BY … LIMIT), head (ascending LIMIT), range (consumed_seq or timestamp bound), WHOLE (no limit, count or aggregate).

| # | file:line | function / const | kind | JSON paths used to filter | scope |
|---|---|---|---|---|---|
| 1 | storage/repositories/sdk-message-repository.ts:119 | HAS_TERMINAL_RESULT_AFTER_SQL / hasTerminalResultAfter | READ-filter | $.internal_compaction_turn, $.is_error, $.recovery_intercepted, $.recovery_billing_terminal | range, LIMIT 1 |
| 2 | …repository.ts:140 | GET_TURN_ERROR_RESULT_SUBTYPE_SQL / getTurnErrorResultSubtype | READ-filter | $.is_error (CASE), $.internal_compaction_turn, $.recovery_intercepted, $.recovery_billing_terminal | range, LIMIT 1 |
| 3 | …repository.ts:171 | HAS_RECOVERY_INTERCEPTED_RESULT_AFTER_SQL | READ-filter | $.recovery_intercepted, $.recovery_billing_terminal | range, LIMIT 1 |
| 4 | …repository.ts:94, run at :1499 | USER_STATUS_MESSAGE_SQL / getUserMessagesByStatus count | READ-filter | $.type, $.isReplay | WHOLE count per session and status |
| 5 | …repository.ts:266, run at :687 | upsertMessageSearchRow admission lookup | READ-output | – | key id |
| 6 | …repository.ts:920 | saveSDKMessageWithAdmission | WRITE insert | – | – |
| 7 | …repository.ts:958 | saveSDKMessageWithAdmission | WRITE update (json_set) | sets $.internal_compaction_turn | key id |
| 8 | …repository.ts:1002 | getRenderableTextMessages | READ-output | – | tail batches |
| 9 | …repository.ts:1054 | _getSDKMessagesImpl | BOTH | $.level | tail |
| 10 | …repository.ts:1117 | _getSDKMessagesImpl subagent query | READ-output | – | parent_tool_use_id IN (…) |
| 11 | …repository.ts:1132 | getMessageByUuid | READ-output | – | key |
| 12 | …repository.ts:1140 | getBackgroundTaskMessages | BOTH | COALESCE($.task_id, task_id), $.tool_use_id | tail 300 plus WHOLE per subtype |
| 13 | …repository.ts:1247 | getSDKMessagesByType | READ-output | – | head |
| 14 | …repository.ts:1272 | getLatestSDKMessagesByType | READ-output | – | tail |
| 15 | …repository.ts:1282 | getLastSDKMessage | READ-output | – | tail 1 |
| 16 | …repository.ts:1505 | getUserMessagesByStatus projection | READ-filter | $.type, $.isReplay | tail, or WHOLE without a limit |
| 17 | …repository.ts:1520 | getUserMessagesByStatus hydration | READ-output | – | key rowid IN |
| 18 | …repository.ts:1569 | listUserMessagesByUuidPrefix | READ-output | – | uuid range, paged |
| 19 | …repository.ts:1606 | getMessageByStatusAndUuid | READ-output | – | key |
| 20 | …repository.ts:1628 | getMessageByStatusAndDbId | READ-output | – | key |
| 21 | …repository.ts:1646 | getUserMessageIdsByStatus | READ-filter | $.type, $.isReplay | WHOLE per status |
| 22 | …repository.ts:1668 | listQueuedInputs | READ-filter | $.inputKind | enqueued rows |
| 23 | …repository.ts:1679 | lastConsumedInputSeq | READ-filter | $.inputKind IS NOT NULL | tail 1 |
| 24 | …repository.ts:1782 | deletePendingUserMessage | READ-output (uuid) | – | key |
| 25 | …repository.ts:1834 | deferEnqueuedUserMessage | READ-output (uuid) | – | key |
| 26 | …repository.ts:1894 | getUserMessages | READ-output | – | WHOLE |
| 27 | …repository.ts:1918 | getUserMessageByUuid | READ-output | – | key |
| 28 | …repository.ts:1933 | getStoredPromptsByUuid | READ-output | – | key |
| 29 | …repository.ts:1950 | getHumanPrompt | READ-output | – | key |
| 30 | …repository.ts:1984 | lastHumanPromptAt | READ-filter | $.inputKind = 'human' | tail 1 |
| 31 | …repository.ts:1997 | getUserMessageContentByUuid | READ-output | – | key |
| 32 | …repository.ts:2018 | readRestartRecoveryEvidence | READ-filter | any $.message.content[*].type = 'tool_result' | tail 1 |
| 33 | …repository.ts:2045 | getDeliveryContent | READ-output | – | key |
| 34 | …repository.ts:2078 | normalizeDeliveryMessageForMailbox select | READ-output | – | key |
| 35 | …repository.ts:2089 | normalizeDeliveryMessageForMailbox apply | WRITE update (full body) | – | key |
| 36 | …repository.ts:2110 | markResultRecoveryIntercepted | WRITE update (json_set) | sets $.recovery_intercepted, $.recovery_billing_terminal | key |
| 37 | …repository.ts:2125 | markResultInternalCompactionTurn | WRITE update (json_set) | sets $.internal_compaction_turn | key |
| 38 | …repository.ts:2258 | markDeliveriesConsumedAtTurnEnd | READ-filter | $.internal_compaction_turn | key, LIMIT 1 |
| 39 | …repository.ts:2364 | hasConsumedTaskInputForSession | READ-filter | $.type, $.inputKind, $.isSynthetic | EXISTS |
| 40 | …repository.ts:2429 and :2440 | getAssistantMessagesSince (two variants) | READ-output | – | WHOLE since a time |
| 41 | …repository.ts:2509 | saveHyperNeoActionMessageWithAdmission | WRITE insert | – | – |
| 42 | …repository.ts:2525 | hasUnresolvedHyperNeoAction | READ-filter | $.resolved = 0 | EXISTS |
| 43 | …repository.ts:2538 | updateHyperNeoActionMessage | WRITE update | changes $.resolved | key |
| 44 | …repository.ts:2560 | updateHyperNeoActionMessageByUuid | WRITE update | changes $.resolved | key |
| 45 | …repository.ts:1446 | saveUserMessageCoreWithAdmission | WRITE insert | – | – |
| 46 | lib/live-query/queries/messages.ts:59 | BACKGROUND_TASK_METADATA_SQL | BOTH | COALESCE($.task_id, task_id), $.tool_use_id | tail 300 plus WHOLE per subtype |
| 47 | lib/live-query/queries/messages.ts:189 | MESSAGES_BY_SESSION_SQL | BOTH | $.level; tool_use ids from $.message.content for the subagent join | tail plus parent IN |
| 48 | lib/live-query/queries/task-messages.ts:158 | sdk_rows_raw | BOTH | $.level | WHOLE task |
| 49 | lib/live-query/queries/session-groups.ts:66 | SESSION_GROUP_MESSAGES_BY_GROUP_SQL | READ-output | – | WHOLE group |
| 50 | storage/repositories/session-repository.ts:504 | rebuildMessageSearchRows | BOTH | $.uuid; text and thinking blocks | WHOLE session |
| 51 | lib/live-query/queries/compact-task-messages.ts:183 | SPACE_TASK_MESSAGES_BY_TASK_COMPACT_SQL | READ-output | – | key window ≤100 |
| 52 | lib/live-query/queries/task-active-turn.ts:35 | SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL | BOTH | $.subtype, $.hook_id, $.isReplay, content block types; tool_result-only rows dropped | active turn |
| 53 | lib/drivers/space-input-evidence.ts:17 | CONSUMED_INPUT (fragment, not a statement) | – | $.isReplay, $.internal_compaction_turn, $.message.content[0].type | used by #55, #56, #61 |
| 54 | …space-input-evidence.ts:27 | readInput | READ-output | – | key |
| 55 | …space-input-evidence.ts:64 | readReplies probe | READ-filter | #53 paths | EXISTS |
| 56 | …space-input-evidence.ts:70 | readReplies | BOTH | $.internal_compaction_turn, $.recovery_intercepted, $.recovery_billing_terminal, #53 | range, LIMIT 40 |
| 57 | storage/schema/task-message-rows.ts:189 | trigger task_message_rows_ai | BOTH (derive) | $.subtype, $.level, $.resolved, content blocks, artifact inputs | key NEW.rowid |
| 58 | task-message-rows.ts:195 | trigger task_message_rows_au | BOTH (derive) | same as #57 | key |
| 59 | task-message-rows.ts:220 | ensureTaskMessageRows | BOTH (derive) | same as #57 | WHOLE task |
| 60 | task-message-rows.ts:232 | addTaskMessageArtifactKeys (m305 only) | BOTH (derive) | artifact paths | flagged rows |
| 61 | lib/drivers/space-adapter.ts:362 | readSpaceStartReceipt | READ-filter | #53 paths | head 1 |
| 62 | lib/drivers/hyperneo-adapter.ts:58 | LANDED_INPUT (fragment, not a statement) | – | $.inputKind <> 'system', $.message.content[0].type = 'text' | used by #64, #65 |
| 63 | hyperneo-adapter.ts:355 | readHyperneoLastResult | BOTH | $.internal_compaction_turn | tail 1 |
| 64 | hyperneo-adapter.ts:382 | readHyperneoInputs tail | BOTH | #62 | tail 8 |
| 65 | hyperneo-adapter.ts:389 | readHyperneoInputs since | BOTH | #62 | range, LIMIT 50 |
| 66 | hyperneo-adapter.ts:424 | readHyperneoExchange | BOTH | $.internal_compaction_turn, $.message.content[0].type | tail 41 |
| 67 | lib/space/runtime/task-agent-manager.ts:1993 | hasConsumedTaskInputSince | READ-filter | $.type, $.inputKind, $.isSynthetic | EXISTS since a time |
| 68 | lib/space/runtime/space-runtime.ts:5303 | rehydrateDigestHandoffDebt | READ-output | – | cross-session uuid range |
| 69 | lib/session/space-session-reads.ts:221 | listSessionMessages | READ-output | – | tail |
| 70 | lib/agent/message-delivery-outbox.ts:325 | PROMPT_ROW_BY_UUID_SQL | READ-output | – | key |
| 71 | message-delivery-outbox.ts:622 | verifyPromptContent | READ-output | – | key |
| 72 | lib/evolution/conversation-analysis-service.ts:88 | loadTraceRows | READ-output | – | tail per task |
| 73 | lib/evolution/trace-evidence-service.ts:118 | loadTraceRows | READ-output | – | tail per task |
| 74 | lib/db-query/scoped-query.ts:297 | materializeScopedTable | READ-output (copy) | – | WHOLE space scope |

Totals: 73 statements (#53 and #62 are fragments, and #40 counts twice). That's 3 inserts, 6 body updates, 32 body outputs, 16 filters and 16 both.
