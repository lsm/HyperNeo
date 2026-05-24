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
import type { SDKMessage, SDKSystemMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { ChatMessage } from '@neokai/shared';

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
}

/**
 * Hook for computing memoized message lookup maps
 */
export function useMessageMaps(
  messages: ChatMessage[],
  sessionId: string,
  removedOutputs: string[] = []
): UseMessageMapsResult {
  // Cast to SDKMessage[] for duck-typed property access; NeokaiActionMessage will not match
  // 'user'/'assistant'/'system' checks and will be safely skipped by all maps.
  const sdkMessages = messages as SDKMessage[];

  // Map of tool use IDs to their results
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ToolResultData>();
    sdkMessages.forEach((msg) => {
      if (msg.type === 'user' && Array.isArray(msg.message.content)) {
        msg.message.content.forEach((block: unknown) => {
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type === 'tool_result' && blockObj.tool_use_id) {
            const toolUseId = blockObj.tool_use_id as string;
            const isRemoved = msg.uuid ? removedOutputs.includes(msg.uuid) : false;
            map.set(toolUseId, {
              content: block,
              messageUuid: msg.uuid,
              sessionId,
              isOutputRemoved: isRemoved,
            });
          }
        });
      }
    });
    return map;
  }, [sdkMessages, removedOutputs, sessionId]);

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
  // Sub-agent messages have parent_tool_use_id set to the Task tool's ID
  const subagentMessagesMap = useMemo(() => {
    const map = new Map<string, SDKMessage[]>();
    sdkMessages.forEach((msg) => {
      const msgWithParent = msg as SDKMessage & {
        parent_tool_use_id?: string | null;
      };
      if (msgWithParent.parent_tool_use_id) {
        const existing = map.get(msgWithParent.parent_tool_use_id) || [];
        existing.push(msg);
        map.set(msgWithParent.parent_tool_use_id, existing);
      }
    });
    return map;
  }, [sdkMessages]);

  return {
    toolResultsMap,
    toolInputsMap,
    sessionInfoMap,
    subagentMessagesMap,
  };
}
