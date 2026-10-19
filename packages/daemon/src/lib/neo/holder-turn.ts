import { resumedPromptUuid } from '../agent/restart-turn-recovery.ts';
import { NeoAskForwardRepository } from '../../storage/repositories/neo-ask-forward-repository.ts';
import {
  neoForwardedAskMessageId,
  neoForwardHop,
  neoTurnOwnsMessage,
} from './ask-forward-operation.ts';
import { NeoCoordinatorTurn } from './coordinator-turn.ts';

export class NeoHolderTurn extends NeoCoordinatorTurn {
  override bind(messageId: string): boolean {
    this.claim();
    const item = this.db
      .getDatabase()
      .prepare(`SELECT id, status
      FROM neo_consultations WHERE session_id = ? AND 'neo-consult:' || id || ':request' = ?`)
      .get(this.sessionId, resumedPromptUuid(messageId)) as { id: string; status: string } | null;
    if (item && item.status !== 'pending') {
      this.closed = true;
      return false;
    }
    if (item) return this.open(messageId, null, false, item.id);
    return this.open(messageId, this.humanOrigin(messageId), this.ownsForward(messageId));
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
}
