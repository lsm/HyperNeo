import type { Database } from '../../storage/database.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { resumedPromptUuid } from '../agent/restart-turn-recovery.ts';
import { neoHumanTrigger, neoHumanTurnOrigin } from './notification-triggers.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';
import { NeoAskForwardRepository } from '../../storage/repositories/neo-ask-forward-repository.ts';
import {
  neoForwardedAskMessageId,
  neoForwardHop,
  neoTurnOwnsMessage,
} from './ask-forward-operation.ts';

export class NeoHolderTurn {
  private bound = false;
  private closed = false;
  private turn?: OperationCaller['neoTurn'];
  private end: () => void = () => {};
  readonly ended = new Promise<void>((resolve) => {
    this.end = resolve;
  });

  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
    private readonly attempt: { isLive(): boolean; yield?(): void }
  ) {}

  bind(messageId: string): boolean {
    if (this.bound || this.closed) throw new Error('Holder turn already bound or closed.');
    this.bound = true;
    const item = this.db
      .getDatabase()
      .prepare(`SELECT id, status
      FROM neo_consultations WHERE session_id = ? AND 'neo-consult:' || id || ':request' = ?`)
      .get(this.sessionId, resumedPromptUuid(messageId)) as { id: string; status: string } | null;
    if (item && item.status !== 'pending') {
      this.closed = true;
      return false;
    }
    const origin = item
      ? null
      : neoHumanTurnOrigin(
          messageId,
          new NeoInputOriginRepository(this.db.getDatabase()).trigger(this.sessionId, messageId),
          (id) =>
            this.db
              .getSDKMessageRepo()
              .getStoredPromptsByUuid(this.sessionId, id)
              .some(
                (message) =>
                  message.type === 'user' && 'inputKind' in message && message.inputKind === 'human'
              )
        );
    const human = origin !== null || (!item && this.ownsForward(messageId));
    this.turn = {
      messageId,
      ...(origin && origin !== messageId ? { origin } : {}),
      consultationId: item?.id,
      human,
      isLive: () => !this.closed && this.attempt.isLive(),
      yield: () => {
        if (!this.turn?.isLive()) return;
        this.dispose();
        this.attempt.yield?.();
      },
    };
    return true;
  }

  steers(): boolean {
    const repo = new NeoRepository(this.db.getDatabase());
    return repo.defaultBinding()?.sessionId === this.sessionId;
  }

  published(messageId: string): boolean {
    const conversationId = new NeoRepository(this.db.getDatabase()).conversationId();
    return (
      !!conversationId &&
      !!new NeoPublicationRepository(this.db.getDatabase()).byTrigger(
        conversationId,
        neoHumanTrigger(messageId)
      )
    );
  }

  private ownsForward(messageId: string): boolean {
    const askMessageId = neoForwardedAskMessageId(messageId);
    const hop = neoForwardHop(messageId);
    if (askMessageId === null || hop === null) return false;
    const forwards = new NeoAskForwardRepository(this.db.getDatabase());
    const ask = forwards.findTo(this.sessionId, askMessageId, hop);
    return (
      !!ask && neoTurnOwnsMessage(this.sessionId, { messageId, human: false }, forwards.list(ask))
    );
  }

  identity(): OperationCaller['neoTurn'] {
    return this.turn;
  }

  dispose(): void {
    this.closed = true;
    this.end();
  }
}
