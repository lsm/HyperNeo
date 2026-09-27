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

  bind(messageId: string): void {
    if (this.bound || this.closed) throw new Error('Holder turn already bound or closed.');
    this.bound = true;
    const item = this.db
      .getDatabase()
      .prepare(`SELECT id, created_at AS createdAt
      FROM neo_consultations WHERE session_id = ? AND 'neo-consult:' || id || ':request' = ?`)
      .get(this.sessionId, messageId) as { id: string; createdAt: number } | null;
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
      this.timer = setTimeout(
        () => {
          const live = this.attempt.isLive();
          this.dispose();
          if (live) this.expire();
        },
        Math.max(0, item.createdAt + CONSULTATION_TIMEOUT_MS - Date.now())
      );
      this.timer.unref?.();
    }
  }

  identity(): OperationCaller['neoTurn'] {
    return this.turn;
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
