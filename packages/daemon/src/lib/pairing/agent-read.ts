import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import {
  deviceKindByCredential,
  type DeviceKind,
} from '../../storage/repositories/device-pairing-repository.ts';
import { readDeviceCredential } from './upgrade-auth.ts';
import { isAgentReadRequest } from './read-page.ts';
import superpipe, { type PipelineAPI } from 'superpipe';

export const AGENT_READ_HINT =
  'Device pairing required. Agents can read this card with hyperneo read <link>.';

export function createAgentReadGuard(db: () => DbGateway) {
  return (superpipe({})('agent-read-guard') as PipelineAPI)
    .input(['req'])
    .pipe(readDeviceCredential, 'req', 'credential')
    .pipe(
      (credential: string | null) => (credential ? { value: credential } : { reason: null }),
      'credential',
      'result:response'
    )
    .pipe((credential: string) => db().run(deviceKindByCredential, credential), 'response', 'kind')
    .pipe(
      (kind: DeviceKind | null, req: Request) => ({
        value:
          kind === 'agent' && !isAgentReadRequest(req)
            ? new Response(AGENT_READ_HINT, {
                status: 401,
                headers: { 'Cache-Control': 'no-store' },
              })
            : null,
      }),
      ['kind', 'req'],
      'result:response'
    )
    .endAsync('response') as (req: Request) => Promise<Response | null>;
}
