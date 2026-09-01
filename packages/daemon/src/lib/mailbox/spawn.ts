import type { MailboxAddress } from './address.ts';

export interface MailboxSessionRef {
  sessionId: string;
  spawned: boolean;
}

export function findOrSpawnSessionForAddress(_address: MailboxAddress): Promise<MailboxSessionRef> {
  throw new Error('mailbox: findOrSpawnSessionForAddress not implemented');
}
