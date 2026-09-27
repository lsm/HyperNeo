import type { Database } from '../../storage/database.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { CONSULTATION_TIMEOUT_MS } from './consultation-policy.ts';

export class NeoHolderTurn {
  private bound = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private turn?: OperationCaller['neoTurn'];

  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
    private readonly attempt: { isLive(): boolean },
    private readonly expire: () => void
  ) {}

  bind(messageId: string): boolean {
    if (this.bound || this.closed) throw new Error('Holder turn already bound or closed.');
    this.bound = true;
    const item = this.db
      .getDatabase()
      .prepare(`SELECT id, status, created_at AS createdAt
      FROM neo_consultations WHERE session_id = ? AND 'neo-consult:' || id || ':request' = ?`)
      .get(this.sessionId, messageId) as { id: string; status: string; createdAt: number } | null;
    const remaining = item ? item.createdAt + CONSULTATION_TIMEOUT_MS - Date.now() : 0;
    if (item && (item.status !== 'pending' || remaining <= 0)) {
      this.closed = true;
      return false;
    }
    const human =
      !item &&
      this.db
        .getSDKMessageRepo()
        .getStoredPromptsByUuid(this.sessionId, messageId)
        .some(
          (message) =>
            message.type === 'user' && 'inputKind' in message && message.inputKind === 'human'
        );
    this.turn = {
      messageId,
      consultationId: item?.id,
      human,
      isLive: () => !this.closed && this.attempt.isLive(),
    };
    if (item) {
      this.timer = setTimeout(() => {
        const live = this.attempt.isLive();
        this.dispose();
        if (live) this.expire();
      }, remaining);
      this.timer.unref?.();
    }
    return true;
  }

  identity(): OperationCaller['neoTurn'] {
    return this.turn;
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
