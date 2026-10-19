import { resumedPromptUuid } from '../agent/restart-turn-recovery.ts';
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
    return this.open(messageId, this.humanOrigin(messageId), false);
  }
}
