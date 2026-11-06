import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { deviceKindByCredential } from '../../storage/repositories/device-pairing-repository.ts';
import { readDeviceCredential } from './upgrade-auth.ts';
import { isAgentReadRequest } from './read-page.ts';

export const AGENT_READ_HINT =
  'Device pairing required. Agents can read this card with hyperneo read <link>.';

export function createAgentReadGuard(db: () => DbGateway) {
  return async (req: Request): Promise<Response | null> => {
    const credential = readDeviceCredential(req);
    if (!credential) return null;
    const kind = await db().run(deviceKindByCredential, credential);
    return kind === 'agent' && !isAgentReadRequest(req)
      ? new Response(AGENT_READ_HINT, { status: 401, headers: { 'Cache-Control': 'no-store' } })
      : null;
  };
}
