import type { MailboxAddressResolution } from './resolution.ts';

export interface MailboxSessionRef {
  sessionId: string;
  spawned: boolean;
}

export function findOrSpawnSessionForAddress(
  _resolution: MailboxAddressResolution
): Promise<MailboxSessionRef> {
  throw new Error('mailbox: findOrSpawnSessionForAddress not implemented');
}
