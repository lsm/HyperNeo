import { parseRemoteAddress } from '../mailbox/address.ts';
import { isWorkerAdapter } from '@hyperneo/shared/types/worker-identity';
import type { WorkRef } from '../drivers/types.ts';

export function sessionWorkerRef(id: string, local: boolean): WorkRef {
  const remote = parseRemoteAddress(id);
  if (remote) return { adapter: 'hyperneo', id: remote.sessionId, daemon: remote.daemonId };
  const split = id.indexOf(':');
  return !local && split > 0 && isWorkerAdapter(id.slice(0, split))
    ? { adapter: id.slice(0, split), id: id.slice(split + 1) }
    : { adapter: 'hyperneo', id };
}
