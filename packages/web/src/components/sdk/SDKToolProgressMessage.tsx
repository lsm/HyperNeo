import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { ToolProgressCard } from './tools/index.ts';

type ToolProgressMessage = Extract<SDKMessage, { type: 'tool_progress' }>;

interface Props {
  message: ToolProgressMessage;
  toolInput?: unknown;
}

export function SDKToolProgressMessage({ message, toolInput }: Props) {
  return (
    <ToolProgressCard
      toolName={message.tool_name}
      toolInput={toolInput}
      elapsedTime={message.elapsed_time_seconds}
      toolUseId={message.tool_use_id}
      parentToolUseId={message.parent_tool_use_id || undefined}
      variant="default"
    />
  );
}
