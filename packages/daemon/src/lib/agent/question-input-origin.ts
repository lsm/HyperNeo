import type { PendingUserQuestion } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';

type Origin = NonNullable<PendingUserQuestion['inputOrigin']>;
type Gate<T> = { value: T } | { reason: null };
type Input = { sessionId: string; messageIds: readonly string[] };
export type QuestionInputOriginSource = () => Origin | null;

export function requireQuestionInputScope(
  sessionId: string,
  messageIds: readonly string[],
  live: boolean
): Gate<Input> {
  return live && typeof sessionId === 'string' && !!sessionId.trim() && Array.isArray(messageIds)
    ? { value: { sessionId, messageIds } }
    : { reason: null };
}

export function requireSingleQuestionInput({ sessionId, messageIds }: Input): Gate<Origin> {
  const messageId = messageIds[0];
  return messageIds.length === 1 && typeof messageId === 'string' && !!messageId.trim()
    ? { value: { sessionId, messageId } }
    : { reason: null };
}

export const projectQuestionInputOrigin = (superpipe({})('question-input-origin') as PipelineAPI)
  .input(['sessionId', 'messageIds', 'live'])
  .pipe(requireQuestionInputScope, ['sessionId', 'messageIds', 'live'], 'result:origin')
  .pipe(requireSingleQuestionInput, 'origin', 'result:origin')
  .end('origin') as (
  sessionId: string,
  messageIds: readonly string[],
  live: boolean
) => Origin | null;

export class QuestionInputScope {
  private messageIds: string[] = [];
  private unknown = false;

  constructor(
    private readonly sessionId: string,
    private readonly live: () => boolean
  ) {}

  recordInput(message: SDKUserMessage & { internal?: boolean }): void {
    if (message.internal || !message.uuid) this.unknown = true;
    if (message.parent_tool_use_id || message.internal || !message.uuid) return;
    if (this.messageIds.length < 2 && !this.messageIds.includes(message.uuid))
      this.messageIds.push(message.uuid);
  }

  endTurn(): void {
    this.messageIds = [];
    this.unknown = false;
  }

  origin(): Origin | null {
    return projectQuestionInputOrigin(
      this.sessionId,
      this.messageIds,
      this.live() && !this.unknown
    );
  }
}
