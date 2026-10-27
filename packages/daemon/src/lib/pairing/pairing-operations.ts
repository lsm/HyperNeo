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
  readonly revoked: (deviceId: string) => void;
}

export const ALLOW_NEEDS_PAIRED_HUMAN =
  'not_paired: only a paired human device can allow a code. Allow it on the phone or browser you paired first.';

export const fromDoor = (caller: OperationCaller) =>
  caller.source === 'mcp' && caller.principal === SESSION_DOOR_PRINCIPAL;

export const NEEDS_PAIRED_HUMAN =
  'not_paired: only a paired human device or the local CLI can manage devices.';

export const NO_HUMAN_DEVICE =
  'no_human_device: no active human device can Allow this code. For lost-phone recovery, run hyperneo devices reset-human on the daemon machine, then hyperneo pair. The reset notifies Neo.';

export function planPairingCode(
  caller: OperationCaller,
  paired: { all: number; humans: number },
  callerIsPairedHuman: boolean,
  recovery = false
): { approved: boolean } | { reason: string } | null {
  if (callerIsPairedHuman) return { approved: true };
  if (!isLocalUser(caller) && !fromDoor(caller)) return null;
  if (fromDoor(caller) && recovery) return { approved: true };
  if (paired.all === 0) return { approved: true };
  return paired.humans === 0 ? { reason: NO_HUMAN_DEVICE } : { approved: false };
}

export function createDevicePairingOperations({
  repo: pairing,
  limiter,
  now,
  revoked,
}: PairingOperationDeps) {
  const isPairedHuman = (caller: OperationCaller) =>
    isLocalUser(caller) &&
    caller.device?.kind === 'human' &&
    pairing().isActiveDevice(caller.device.deviceId);
  return [
    defineOperation({
      name: 'device.pair.create',
      description:
        'Make a single-use pairing code, valid 10 minutes, for a new device of the given kind. The local CLI makes the first device’s code; later codes need Allow from a paired human. Explicit local devices reset-human recovery permits one replacement human pairing without Allow.',
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
        const plan = planPairingCode(
          caller,
          pairing().countDevices(),
          isPairedHuman(caller),
          input.kind === 'human' && pairing().humanRecoveryOpen()
        );
        if (!plan) return refused;
        if ('reason' in plan) return { ok: false as const, reason: plan.reason };
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
        'List issued codes waiting for Allow by an active paired human (never the codes themselves).',
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
        isPairedHuman(caller)
          ? { ok: true as const, pending: pairing().listPending(now()) }
          : { ok: false as const, reason: NEEDS_PAIRED_HUMAN },
    }),
    defineOperation({
      name: 'device.pair.approve',
      description: 'Allow a pending pairing code so its device can pair.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({ codeId: z.string().min(1) }).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: async (input, caller) => {
        if (!isLocalUser(caller)) return refused;
        if (caller.device?.kind !== 'human')
          return { ok: false as const, reason: ALLOW_NEEDS_PAIRED_HUMAN };
        const approved = await pairing().approveAsync(input.codeId, caller.device.deviceId, now());
        if (approved === 'not_paired')
          return { ok: false as const, reason: ALLOW_NEEDS_PAIRED_HUMAN };
        return approved === 'approved'
          ? { ok: true as const }
          : { ok: false as const, reason: 'not_pending: no pending code with that id.' };
      },
    }),
    defineOperation({
      name: 'device.list',
      description:
        'List paired devices with their kind, last sighting and whether they were revoked; never a credential.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          devices: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              kind: Kind,
              createdAt: z.number(),
              lastSeenAt: z.number().nullable(),
              lastSeenHost: z.string().nullable(),
              revokedAt: z.number().nullable(),
              current: z.boolean(),
            })
          ),
        }),
        Refused,
      ]),
      execute: async (_input, caller) => {
        if (!isLocalUser(caller) && !fromDoor(caller)) return refused;
        if (!fromDoor(caller) && !isPairedHuman(caller))
          return { ok: false as const, reason: NEEDS_PAIRED_HUMAN };
        return {
          ok: true as const,
          devices: pairing()
            .listDevices()
            .map((device) => ({ ...device, current: device.id === caller.device?.deviceId })),
        };
      },
    }),
    defineOperation({
      name: 'device.unpaired.list',
      description:
        'List connections seen without a paired device credential (kind, origin, host, address, counts); never a credential. Any local caller or the session door can read this diagnostic; agents cannot.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          connections: z.array(
            z.object({
              client: z.enum(['browser', 'native']),
              origin: z.string().nullable(),
              host: z.string().nullable(),
              remoteAddress: z.string().nullable(),
              credentialRejected: z.boolean(),
              count: z.number(),
              firstSeenAt: z.number(),
              lastSeenAt: z.number(),
            })
          ),
        }),
        Refused,
      ]),
      execute: async (_input, caller) => {
        if (!isLocalUser(caller) && !fromDoor(caller)) return refused;
        return { ok: true as const, connections: pairing().listUnpaired() };
      },
    }),
    defineOperation({
      name: 'device.would_refuse.list',
      description:
        'List requests the Origin/Host checks would refuse once pairing is required (reason, kind, host, origin, counts). Nothing is refused yet. Any local caller or the session door can read this diagnostic; agents cannot.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        z.object({
          ok: z.literal(true),
          requests: z.array(
            z.object({
              reason: z.enum(['host_not_allowed', 'origin_not_allowed']),
              kind: z.enum(['http', 'ws', 'preflight']),
              host: z.string().nullable(),
              origin: z.string().nullable(),
              count: z.number(),
              firstSeenAt: z.number(),
              lastSeenAt: z.number(),
            })
          ),
        }),
        Refused,
      ]),
      execute: async (_input, caller) => {
        if (!isLocalUser(caller) && !fromDoor(caller)) return refused;
        return { ok: true as const, requests: pairing().listWouldRefuse() };
      },
    }),
    defineOperation({
      name: 'device.revoke',
      description:
        'Revoke a paired device: its credential stops working and its open connections close. Revoking never reopens pairing without Allow.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({ deviceId: z.string().min(1) }).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: async (input, caller) => {
        if (!isLocalUser(caller) && !fromDoor(caller)) return refused;
        if (!fromDoor(caller) && !isPairedHuman(caller))
          return { ok: false as const, reason: NEEDS_PAIRED_HUMAN };
        if (!pairing().revokeDevice(input.deviceId, now()))
          return { ok: false as const, reason: 'not_found: no paired device with that id.' };
        revoked(input.deviceId);
        return { ok: true as const };
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
