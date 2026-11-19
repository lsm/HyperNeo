import type { OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import type { NeoService } from './service.ts';

export type Rejection = { ok: false; reason: string };

export function admitNeoCaller(
  service: NeoService,
  caller: OperationCaller,
  name: string
): { value: OperationCaller } | { reason: Rejection } {
  if (isLocalUser(caller)) return { value: caller };
  const binding = caller.sessionId ? service.repo.getBindingBySession(caller.sessionId) : null;
  if (caller.source !== 'mcp' || binding?.kind !== 'neo')
    return { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
  if (['neo.restart', 'neo.session.track', 'neo.front.set'].includes(name))
    return { reason: { ok: false, reason: 'This action needs the user.' } };
  return { value: caller };
}
