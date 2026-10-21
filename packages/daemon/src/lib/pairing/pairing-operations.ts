import { z } from 'zod';
import type { DevicePairingRepository } from '../../storage/repositories/device-pairing-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { PairingLimiter } from './pairing-limiter.ts';

export const SESSION_DOOR_PRINCIPAL = 'session-door';

const Kind = z.enum(['human', 'relay', 'daemon']);
const Refused = z.object({ ok: z.literal(false), reason: z.string() });
const refused = { ok: false as const, reason: 'This action needs the user.' };

export interface PairingOperationDeps {
  readonly repo: () => DevicePairingRepository;
  readonly limiter: PairingLimiter;
  readonly now: () => number;
}

export const ALLOW_NEEDS_PAIRED_HUMAN =
  'not_paired: only a paired human device can allow a code. Allow it on the phone or browser you paired first.';

const fromDoor = (caller: OperationCaller) =>
  caller.source === 'mcp' && caller.principal === SESSION_DOOR_PRINCIPAL;

const isPairedHuman = (caller: OperationCaller) =>
  isLocalUser(caller) && caller.device?.kind === 'human';

export function planPairingCode(
  caller: OperationCaller,
  pairedHumans: number
): { approved: boolean } | null {
  if (isPairedHuman(caller)) return { approved: true };
  if (isLocalUser(caller) || fromDoor(caller)) return { approved: pairedHumans === 0 };
  return null;
}

export function createDevicePairingOperations({
  repo: pairing,
  limiter,
  now,
}: PairingOperationDeps) {
  return [
    defineOperation({
      name: 'device.pair.create',
      description:
        'Make a single-use pairing code, valid 10 minutes, for a new device of the given kind. The local CLI makes the first human device’s code; once a human device is paired, other codes wait for the human to allow it on a paired device.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z
        .object({ kind: Kind, name: z.string().trim().min(1).max(80).optional() })
        .strict(),
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          codeId: z.string(),
          code: z.string(),
          expiresAt: z.number(),
          approval: z.enum(['approved', 'pending']),
        }),
        Refused,
      ]),
      execute: async (input, caller) => {
        const plan = planPairingCode(caller, pairing().countHumanDevices());
        if (!plan) return refused;
        const made = pairing().createCode(input.kind, input.name ?? null, plan.approved, now());
        return {
          ok: true as const,
          codeId: made.id,
          code: made.code,
          expiresAt: made.expiresAt,
          approval: plan.approved ? ('approved' as const) : ('pending' as const),
        };
      },
    }),
    defineOperation({
      name: 'device.pair.pending',
      description:
        'List pairing codes waiting for the human to allow them (never the codes themselves).',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          pending: z.array(
            z.object({
              id: z.string(),
              kind: Kind,
              name: z.string().nullable(),
              expiresAt: z.number(),
            })
          ),
        }),
        Refused,
      ]),
      execute: async (_input, caller) =>
        isLocalUser(caller)
          ? { ok: true as const, pending: pairing().listPending(now()) }
          : refused,
    }),
    defineOperation({
      name: 'device.pair.approve',
      description: 'Allow a pending pairing code so its device can pair.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({ codeId: z.string().min(1) }).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: async (input, caller) => {
        if (!isLocalUser(caller)) return refused;
        if (!isPairedHuman(caller)) return { ok: false as const, reason: ALLOW_NEEDS_PAIRED_HUMAN };
        return pairing().approve(input.codeId, now())
          ? { ok: true as const }
          : { ok: false as const, reason: 'not_pending: no pending code with that id.' };
      },
    }),
    defineOperation({
      name: 'device.pair.reset_lockout',
      description: 'Reopen pairing after too many bad codes locked it.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: async (_input, caller) => {
        if (!isLocalUser(caller) && !fromDoor(caller)) return refused;
        limiter.reset();
        return { ok: true as const };
      },
    }),
  ];
}
