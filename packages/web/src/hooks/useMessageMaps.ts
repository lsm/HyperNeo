import { useMemo } from 'preact/hooks';
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
} from '@hyperneo/shared/sdk/sdk.d.ts';
import type { ChatMessage } from '@hyperneo/shared';
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
  toolResultsMap: Map<string, ToolResultData>;
  toolInputsMap: Map<string, unknown>;
  sessionInfoMap: Map<string, SDKSystemMessage>;
  subagentMessagesMap: Map<string, SDKMessage[]>;
  taskNotificationsMap: Map<string, SDKTaskNotificationMessage>;
  runningToolUseIdsByMessageUuid: Map<string, Set<string>>;
  taskProgressMap: Map<string, SDKTaskProgressMessage>;
  foldableToolUseIds: Set<string>;
  replacementStatusMap: Map<string, MessageReplacementStatus>;
  completedHookUuids: Set<string>;
}

export function useMessageMaps(
  messages: ChatMessage[],
  sessionId: string,
  removedOutputs: string[] = [],
  runningToolUseIds: Set<string> = new Set()
): UseMessageMapsResult {
  const sdkMessages = messages as SDKMessage[];

  const replacementStatusMap = useMemo(
    () => buildMessageReplacementStatusMap(sdkMessages),
    [sdkMessages]
  );

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

  const sessionInfoMap = useMemo(() => {
    const map = new Map<string, SDKSystemMessage>();
    let lastUserUuid: string | undefined;
    const pendingLeadingInits: SDKSystemMessage[] = [];

    for (const msg of sdkMessages) {
      if (msg.type === 'user' && msg.uuid) {
        lastUserUuid = msg.uuid;
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
