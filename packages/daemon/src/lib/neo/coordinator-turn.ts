import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../storage/database.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { neoHumanTurnOrigin } from './notification-triggers.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoInputOriginRepository } from '../../storage/repositories/neo-input-origin-repository.ts';

export type NeoTurnAttempt = { isLive(): boolean; yield?(): void };

export class NeoCoordinatorTurn {
  protected bound = false;
  protected closed = false;
  private turn?: OperationCaller['neoTurn'];
  private readonly carriedInputs = new Set<string>();
  openedAt = 0;
  private end: () => void = () => {};
  readonly ended = new Promise<void>((resolve) => {
    this.end = resolve;
  });

  constructor(
    protected readonly db: Database,
    protected readonly sessionId: string,
    private readonly attempt: NeoTurnAttempt
  ) {}

  bind(messageId: string): boolean {
    this.claim();
    return this.open(messageId, this.humanOrigin(messageId));
  }

  protected claim(): void {
    if (this.bound || this.closed) throw new Error('Neo turn already bound or closed.');
    this.bound = true;
  }

  protected humanOrigin(messageId: string): string | null {
    return neoHumanTurnOrigin(
      messageId,
      new NeoInputOriginRepository(this.db.getDatabase()).trigger(this.sessionId, messageId),
      (id) => this.isHumanInput(id)
    );
  }

  private isHumanInput(messageId: string): boolean {
    return this.db
      .getSDKMessageRepo()
      .getStoredPromptsByUuid(this.sessionId, messageId)
      .some(
        (message) =>
          message.type === 'user' && 'inputKind' in message && message.inputKind === 'human'
      );
  }

  noteSteered(messageId: string): void {
    if (this.turn?.human && !this.isHumanInput(messageId))
      this.turn = { ...this.turn, human: false };
  }

  protected open(messageId: string, origin: string | null): true {
    this.openedAt = Date.now();
    this.turn = {
      messageId,
      ...(origin && origin !== messageId ? { origin } : {}),
      human: origin !== null,
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
    return new NeoRepository(this.db.getDatabase()).defaultBinding()?.sessionId === this.sessionId;
  }

  noteCarried(message: SDKMessage): void {
    if (message.type !== 'result' && (message.type !== 'system' || message.subtype !== 'status'))
      return;
    const uuids = (message as { user_message_uuids?: unknown }).user_message_uuids;
    if (Array.isArray(uuids))
      for (const uuid of uuids) if (typeof uuid === 'string') this.carriedInputs.add(uuid);
  }

  carried(messageId: string): boolean {
    return this.carriedInputs.has(messageId);
  }

  latestHumanInput(): string | undefined {
    const bound = this.turn && (this.turn.origin ?? this.turn.messageId);
    return [...(bound ? [bound] : []), ...this.carriedInputs]
      .filter((id) => this.isHumanInput(id))
      .at(-1);
  }

  identity(): OperationCaller['neoTurn'] {
    return this.turn;
  }

  dispose(): void {
    this.closed = true;
    this.end();
  }
}
