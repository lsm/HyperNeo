/**
 * useMessageMaps Hook
 *
 * Memoized computation of various message lookup maps used in ChatContainer.
 * Extracts the complex O(n) and O(n²) mapping logic for tool results, inputs,
 * and session info.
 *
 * @example
 * ```typescript
 * const maps = useMessageMaps(messages, sessionId, removedOutputs);
 *
 * // Use in message rendering
 * <SDKMessageRenderer
 *   message={msg}
 *   toolResultsMap={maps.toolResultsMap}
 *   toolInputsMap={maps.toolInputsMap}
 *   sessionInfo={maps.sessionInfoMap.get(msg.uuid)}
 * />
 * ```
 */

import { useMemo } from 'preact/hooks';
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
} from '@neokai/shared/sdk/sdk.d.ts';
import type { ChatMessage } from '@neokai/shared';
import {
  buildMessageReplacementStatusMap,
  type MessageReplacementStatus,
} from '../lib/sdk-message-replacement';

export interface ToolResultData {
  content: unknown;
  messageUuid: string | undefined;
  sessionId: string;
  isOutputRemoved: boolean;
}

export interface UseMessageMapsResult {
  /** Map of tool use IDs to their results (with metadata for deletion) */
  toolResultsMap: Map<string, ToolResultData>;
  /** Map of tool use IDs to their input data */
  toolInputsMap: Map<string, unknown>;
  /** Map of user message UUIDs to their attached session init info */
  sessionInfoMap: Map<string, SDKSystemMessage>;
  /** Map of parent tool use IDs to their sub-agent messages */
  subagentMessagesMap: Map<string, SDKMessage[]>;
  /** Map of tool use IDs to their terminal task_notification (status/summary/usage) */
  taskNotificationsMap: Map<string, SDKTaskNotificationMessage>;
  /** Map of assistant message UUIDs to the tool_use IDs currently running in that message. */
  runningToolUseIdsByMessageUuid: Map<string, Set<string>>;
  /** Map of tool use IDs to their latest live task_progress (usage/last tool/summary) */
  taskProgressMap: Map<string, SDKTaskProgressMessage>;
  /**
   * Tool use IDs whose card is actually rendered in this slice — top-level
   * tool_use ids plus nested tool_use ids whose parent Task/Agent card is
   * present (so its SubagentBlock will fold the notification). Used to gate
   * task_notification suppression: a nested tool_use whose parent was paginated
   * out has no render target, so its notification must fall back to a row.
   */
  foldableToolUseIds: Set<string>;
  /** Map of SDK message UUIDs to replacement/retraction status */
  replacementStatusMap: Map<string, MessageReplacementStatus>;
  /**
   * UUIDs of hook_started/hook_progress messages whose run has a terminal
   * hook_response IN THE SAME TURN. Turn-scoped because hook_id is only unique
   * within a turn — a completed run in one turn must not mark a reused
   * hook_id's still-running phase in another turn as finished. Used to render
   * historical phases without a spinner.
   */
  completedHookUuids: Set<string>;
}

/**
 * Hook for computing memoized message lookup maps
 */
export function useMessageMaps(
  messages: ChatMessage[],
  sessionId: string,
  removedOutputs: string[] = [],
  runningToolUseIds: Set<string> = new Set()
): UseMessageMapsResult {
  // Cast to SDKMessage[] for duck-typed property access; NeokaiActionMessage will not match
  // 'user'/'assistant'/'system' checks and will be safely skipped by all maps.
  const sdkMessages = messages as SDKMessage[];

  const replacementStatusMap = useMemo(
    () => buildMessageReplacementStatusMap(sdkMessages),
    [sdkMessages]
  );

  // Map of tool use IDs to their results
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ToolResultData>();
    sdkMessages.forEach((msg) => {
      if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        const replacementStatus = msg.uuid ? replacementStatusMap.get(msg.uuid) : undefined;
        msg.message.content.forEach((block: unknown) => {
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type === 'tool_result' && blockObj.tool_use_id) {
            const toolUseId = blockObj.tool_use_id as string;
            const isReplacementRemoved = !!replacementStatus;
            const isRemoved =
              (msg.uuid ? removedOutputs.includes(msg.uuid) : false) || isReplacementRemoved;
            map.set(toolUseId, {
              content: isReplacementRemoved ? undefined : block,
              messageUuid: msg.uuid,
              sessionId,
              isOutputRemoved: isRemoved,
            });
          }
        });
      }
    });
    return map;
  }, [sdkMessages, removedOutputs, replacementStatusMap, sessionId]);

  // Map of tool use IDs to their input data
  const toolInputsMap = useMemo(() => {
    const map = new Map<string, unknown>();
    sdkMessages.forEach((msg) => {
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        msg.message.content.forEach((block: unknown) => {
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type === 'tool_use' && blockObj.id) {
            map.set(blockObj.id as string, blockObj.input);
          }
        });
      }
    });
    return map;
  }, [sdkMessages]);

  // Map of tool use IDs to their terminal task_notification. task_notification
  // (system, subtype task_notification) carries status/summary/usage and links
  // back to its originating tool_use via tool_use_id. Folded onto the tool card
  // instead of rendered as a standalone system row.
  const taskNotificationsMap = useMemo(() => {
    const map = new Map<string, SDKTaskNotificationMessage>();
    sdkMessages.forEach((msg) => {
      if (msg.type !== 'system' || msg.subtype !== 'task_notification') return;
      const notification = msg as SDKTaskNotificationMessage;
      if (notification.tool_use_id) {
        map.set(notification.tool_use_id, notification);
      }
    });
    return map;
  }, [sdkMessages]);

  const runningToolUseIdsByMessageUuid = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (runningToolUseIds.size === 0) return map;

    sdkMessages.forEach((msg) => {
      if (msg.type !== 'assistant' || !msg.uuid || !Array.isArray(msg.message.content)) return;
      const ids = new Set<string>();
      msg.message.content.forEach((block: unknown) => {
        const blockObj = block as Record<string, unknown>;
        if (blockObj.type === 'tool_use' && typeof blockObj.id === 'string') {
          if (runningToolUseIds.has(blockObj.id)) ids.add(blockObj.id);
        }
      });
      if (ids.size > 0) map.set(msg.uuid, ids);
    });

    return map;
  }, [sdkMessages, runningToolUseIds]);

  // Map of tool use IDs to their latest live task_progress. task_progress
  // carries live usage/summary/last-tool data and links directly to its
  // originating tool_use via tool_use_id. Keep only the latest row per tool.
  const taskProgressMap = useMemo(() => {
    const map = new Map<string, SDKTaskProgressMessage>();
    sdkMessages.forEach((msg) => {
      if (msg.type !== 'system' || msg.subtype !== 'task_progress') return;
      const progress = msg as SDKTaskProgressMessage;
      if (progress.tool_use_id) {
        map.set(progress.tool_use_id, progress);
      }
    });
    return map;
  }, [sdkMessages]);

  // Map of user message UUIDs to their attached session init info
  const sessionInfoMap = useMemo(() => {
    const map = new Map<string, SDKSystemMessage>();
    let lastUserUuid: string | undefined;
    const pendingLeadingInits: SDKSystemMessage[] = [];

    for (const msg of sdkMessages) {
      if (msg.type === 'user' && msg.uuid) {
        lastUserUuid = msg.uuid;
        // Preserve the previous fallback semantics for init rows that appear
        // before the first user message, but do it once when that first user
        // appears instead of scanning forward from each init row. This keeps
        // large SDK conversations O(n) instead of O(n²) on every message batch.
        for (const init of pendingLeadingInits) {
          map.set(msg.uuid, init);
        }
        pendingLeadingInits.length = 0;
        continue;
      }

      if (msg.type !== 'system' || msg.subtype !== 'init') continue;
      const init = msg as SDKSystemMessage;
      if (lastUserUuid) {
        map.set(lastUserUuid, init);
      } else {
        pendingLeadingInits.push(init);
      }
    }
    return map;
  }, [sdkMessages]);

  // Map of parent tool use IDs to their sub-agent messages
  // Sub-agent messages have parent_tool_use_id set to the Task tool's ID.
  // Some SDK rows (e.g. subagent-scoped permission_denied) carry agent_id
  // instead of parent_tool_use_id; when that agent_id matches a Task tool_use
  // id we group them into the same nested timeline.
  const subagentMessagesMap = useMemo(() => {
    const toolUseIds = new Set<string>();
    sdkMessages.forEach((msg) => {
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        msg.message.content.forEach((block: unknown) => {
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type === 'tool_use' && typeof blockObj.id === 'string') {
            toolUseIds.add(blockObj.id as string);
          }
        });
      }
    });

    const map = new Map<string, SDKMessage[]>();
    sdkMessages.forEach((msg) => {
      const msgWithParent = msg as SDKMessage & {
        parent_tool_use_id?: string | null;
      };
      if (msgWithParent.parent_tool_use_id) {
        const existing = map.get(msgWithParent.parent_tool_use_id) || [];
        existing.push(msg);
        map.set(msgWithParent.parent_tool_use_id, existing);
        return;
      }
      const agentId = (msg as { agent_id?: string | null }).agent_id;
      if (agentId && toolUseIds.has(agentId)) {
        const existing = map.get(agentId) || [];
        existing.push(msg);
        map.set(agentId, existing);
      }
    });
    return map;
  }, [sdkMessages]);

  // Tool use IDs whose card actually renders in this slice. Top-level
  // tool_use ids render as ToolResultCard / SubagentBlock headers; a nested
  // tool_use renders only inside its parent SubagentBlock, so it's foldable
  // only when the parent Task/Agent tool_use is also present. A page boundary
  // that keeps a nested tool_use but drops its parent must NOT fold its
  // task_notification — there's no target — so it falls back to a system row.
  const foldableToolUseIds = useMemo(() => {
    const topLevel = new Set<string>();
    sdkMessages.forEach((msg) => {
      if (msg.type !== 'assistant' || !Array.isArray(msg.message.content)) return;
      if ((msg as SDKMessage & { parent_tool_use_id?: string | null }).parent_tool_use_id) return;
      msg.message.content.forEach((block: unknown) => {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string') topLevel.add(b.id);
      });
    });
    const foldable = new Set(topLevel);
    sdkMessages.forEach((msg) => {
      if (msg.type !== 'assistant' || !Array.isArray(msg.message.content)) return;
      const parent = (msg as SDKMessage & { parent_tool_use_id?: string | null })
        .parent_tool_use_id;
      if (!parent || !topLevel.has(parent)) return;
      msg.message.content.forEach((block: unknown) => {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string') foldable.add(b.id);
      });
    });
    return foldable;
  }, [sdkMessages]);

  // UUIDs of hook_started/hook_progress phases whose run has reached
  // hook_response in the SAME turn. hook_id is only unique within a turn, so we
  // track pending phases per turn (a `result` message ends the turn and clears
  // them) and mark a phase completed only when a response for its hook_id
  // arrives before the turn closes. This prevents a completed run in one turn
  // from hiding the spinner on a reused hook_id's still-running phase elsewhere.
  const completedHookUuids = useMemo(() => {
    const completed = new Set<string>();
    const pendingByHook = new Map<string, string[]>();
    const flushTurn = () => pendingByHook.clear();
    for (const msg of sdkMessages) {
      if (msg.type === 'result') {
        flushTurn();
        continue;
      }
      if (msg.type !== 'system') continue;
      const sub = (msg as { subtype?: string }).subtype;
      const hookId = (msg as { hook_id?: string }).hook_id;
      if (!hookId) continue;
      if (sub === 'hook_started' || sub === 'hook_progress') {
        const uuid = (msg as { uuid?: string }).uuid;
        if (uuid) {
          const list = pendingByHook.get(hookId);
          if (list) list.push(uuid);
          else pendingByHook.set(hookId, [uuid]);
        }
      } else if (sub === 'hook_response') {
        for (const uuid of pendingByHook.get(hookId) ?? []) completed.add(uuid);
        pendingByHook.delete(hookId);
      }
    }
    return completed;
  }, [sdkMessages]);

  return {
    toolResultsMap,
    toolInputsMap,
    sessionInfoMap,
    subagentMessagesMap,
    taskNotificationsMap,
    runningToolUseIdsByMessageUuid,
    taskProgressMap,
    foldableToolUseIds,
    replacementStatusMap,
    completedHookUuids,
  };
}
