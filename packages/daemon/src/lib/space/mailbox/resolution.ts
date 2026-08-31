import type { MailboxAddress } from './address.ts';

export type MailboxAddressResolution =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'agent';
      spaceId: string;
      handle: string;
      taskId?: string;
      node?: string;
    };

export function resolveMailboxAddress(_addr: MailboxAddress): MailboxAddressResolution {
  throw new Error('mailbox: resolveMailboxAddress not implemented');
}
