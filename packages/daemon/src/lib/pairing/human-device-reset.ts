import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { createHumanResetCoordinator } from './human-reset-coordinator.ts';
import type { resetHumanDevices } from '../../storage/repositories/human-device-reset-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { fromDoor } from './pairing-operations.ts';
import { announceDeviceRevoked } from './upgrade-auth.ts';

const listeners = new Set<(conversationId: string) => void>();
export function onHumanDevicesReset(listener: (conversationId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function createHumanDeviceResetOperation(db: () => Database) {
  let coordinate: ReturnType<typeof createHumanResetCoordinator> | undefined;
  const reset = (superpipe({})('device.reset_human') as PipelineAPI)
    .input(['caller'])
    .pipe(
      (caller: OperationCaller) =>
        fromDoor(caller)
          ? { value: Date.now() }
          : {
              reason: {
                ok: false,
                reason: 'local_cli_only: run hyperneo devices reset-human on the daemon machine.',
              },
            },
      'caller',
      'result:reset'
    )
    .pipe(
      (now: number) => {
        coordinate ??= createHumanResetCoordinator(gatewayFor(db()), (receipt) => {
          for (const device of receipt.devices) announceDeviceRevoked(device.id);
          for (const listener of listeners) listener(receipt.conversationId);
        });
        return coordinate(now);
      },
      'reset',
      'reset'
    )
    .pipe(
      (receipt: ReturnType<typeof resetHumanDevices>) => ({
        ok: true,
        resetAt: receipt.resetAt,
        devices: receipt.devices,
      }),
      'reset',
      'reset'
    )
    .endAsync('reset') as (caller: OperationCaller) => Promise<unknown>;
  return defineOperation({
    name: 'device.reset_human',
    description:
      'Local CLI lost-phone recovery: revoke human devices, retain history, invalidate pending codes, and notify the human of when and which devices were cleared. The next human pairing needs no Allow; an AI with local shell access can invoke this accepted-risk reset too.',
    inputSchema: z.object({}).strict(),
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.string() }),
      z.object({
        ok: z.literal(true),
        resetAt: z.number(),
        devices: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ]),
    policy: { safetyClass: 'human_only' },
    execute: async (_input, caller) => reset(caller),
  });
}
