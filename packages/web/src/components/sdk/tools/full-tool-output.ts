import { connectionManager } from '../../../lib/connection-manager.ts';

export interface FullToolOutput {
  output: unknown;
  structuredOutput: unknown;
}

export function cappedOutputChars(output: unknown): number | null {
  if (!output || typeof output !== 'object') return null;
  const capped = (output as Record<string, unknown>).output_capped as
    | { chars?: unknown }
    | undefined;
  return typeof capped?.chars === 'number' ? capped.chars : null;
}

export function formatChars(chars: number): string {
  return chars >= 1024 * 1024
    ? `${(chars / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(chars / 1024)} KB`;
}

export async function loadFullToolOutput(
  sessionId: string,
  messageUuid: string,
  toolId: string
): Promise<FullToolOutput> {
  const hub = await connectionManager.getHub();
  const { sdkMessage } = await hub.request<{ sdkMessage: Record<string, unknown> }>(
    'message.sdkMessage',
    { sessionId, messageUuid }
  );
  const content = (sdkMessage.message as { content?: unknown } | undefined)?.content;
  const blocks = Array.isArray(content)
    ? (content as Array<Record<string, unknown>>).filter((block) => block?.type === 'tool_result')
    : [];
  return {
    output: blocks.find((block) => block.tool_use_id === toolId),
    structuredOutput: blocks.length === 1 ? sdkMessage.tool_use_result : undefined,
  };
}
