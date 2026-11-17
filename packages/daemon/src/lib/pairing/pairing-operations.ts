import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  DeviceKind,
  DevicePairingRepository,
} from '../../storage/repositories/device-pairing-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { PairWaits } from './pair-waits.ts';
import type { PairingLimiter } from './pairing-limiter.ts';
import { createDeviceRevoker } from './revoke-device.ts';

export const SESSION_DOOR_PRINCIPAL = 'session-door';

const Kind = z.enum(['human', 'relay', 'daemon', 'agent']);
const Refused = z.object({ ok: z.literal(false), reason: z.string() });
export const refused = { ok: false as const, reason: 'This action needs the user.' };

export interface PairingOperationDeps {
  readonly repo: () => DevicePairingRepository;
  readonly limiter: PairingLimiter;
  readonly now: () => number;
  readonly revoked: (deviceId: string) => void;
  readonly waits: PairWaits;
}

export const ALLOW_NEEDS_PAIRED_HUMAN =
  'not_paired: only a paired human device can allow a code. Allow it on the phone or browser you paired first.';

export const DENY_NEEDS_PAIRED_HUMAN =
  'not_paired: only a paired human device can deny a code. Deny it on the phone or browser you paired first.';

export const fromDoor = (caller: OperationCaller) =>
  caller.source === 'mcp' && caller.principal === SESSION_DOOR_PRINCIPAL;

export const NEEDS_PAIRED_HUMAN =
  'not_paired: only a paired human device or the local CLI can manage devices.';

export const NO_HUMAN_DEVICE =
  'no_human_device: no active human device can Allow this code. For lost-phone recovery, run hyperneo devices reset-human on the daemon machine, then hyperneo pair. The reset notifies Neo.';

export const NOT_REQUESTED =
  'not_requested: the new phone has not confirmed yet. Wait until it shows the confirmation code and asks for confirmation.';

export const WRONG_FINGERPRINT =
  'wrong_fingerprint: the confirmation code did not match the new phone, so the code is denied. Scan a new code.';

export const TERMINAL_APPROVAL_NEEDS_PHONE =
  'not_paired: only a paired phone or browser can turn terminal approval back on.';

const DECIDED_REASON: Partial<Record<string, string>> = {
  not_pending: 'not_pending: no pending code with that id.',
  not_requested: NOT_REQUESTED,
  wrong_fingerprint: WRONG_FINGERPRINT,
};

export function planPairingCode(
  caller: OperationCaller,
  paired: { all: number; humans: number },
  callerIsPairedHuman: boolean,
  recovery = false,
  kind: DeviceKind = 'human'
): { approved: boolean } | { reason: string } | null {
  if (caller.device?.kind === 'agent') return null;
  if (callerIsPairedHuman) return { approved: true };
  if (!isLocalUser(caller) && !fromDoor(caller)) return null;
  if (kind === 'agent' && paired.humans === 0) return { reason: NO_HUMAN_DEVICE };
  if (fromDoor(caller) && recovery) return { approved: true };
  if (paired.all === 0) return { approved: true };
  return paired.humans === 0 ? { reason: NO_HUMAN_DEVICE } : { approved: false };
}

type Refusal = z.infer<typeof Refused>;
type Gate<T> = { value: T } | { reason: Refusal };
type Run<Result> = (input: unknown, caller: OperationCaller) => Promise<Awaited<Result> | Refusal>;

export function createDevicePairingOperations({
  repo: pairing,
  limiter,
  now,
  revoked,
  waits,
}: PairingOperationDeps) {
  const revoke = createDeviceRevoker(pairing, now, revoked);
  const isPairedHuman = (caller: OperationCaller) =>
    isLocalUser(caller) &&
    caller.device?.kind === 'human' &&
    pairing().isActiveDevice(caller.device.deviceId);
  const isPhone = (caller: OperationCaller) =>
    isPairedHuman(caller) && !caller.device?.deviceId.startsWith('local-rpc:');
  const isLocal = (caller: OperationCaller) => isLocalUser(caller) || fromDoor(caller);
  const requireLocal = (caller: OperationCaller): Gate<OperationCaller> =>
    isLocal(caller) ? { value: caller } : { reason: refused };
  const admitDecision =
    (notPaired: string, door: boolean) =>
    (caller: OperationCaller): Gate<string> => {
      if (!isLocalUser(caller) && !(door && fromDoor(caller))) return { reason: refused };
      if (caller.device?.kind !== 'human') return { reason: { ok: false, reason: notPaired } };
      return { value: caller.device.deviceId };
    };
  const settleDecision =
    (notPaired: string) =>
    (decided: string, input: { codeId: string }): { ok: true } | Refusal => {
      waits.release(input.codeId);
      if (decided === 'not_paired') return { ok: false, reason: notPaired };
      const reason = DECIDED_REASON[decided];
      return reason ? { ok: false, reason } : { ok: true };
    };

  const createCode = (
    input: { kind: DeviceKind; name?: string; confirm?: 'two-way' },
    caller: OperationCaller
  ) =>
    pairing().createCodeAsync({
      kind: input.kind,
      name: input.name ?? null,
      caller: {
        source: caller.source,
        principal: caller.principal,
        device: caller.device
          ? { deviceId: caller.device.deviceId, kind: caller.device.kind }
          : undefined,
      },
      now: now(),
      twoWay: input.confirm === 'two-way',
    });
  const create = (superpipe({})('device.pair.create') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(createCode, ['input', 'caller'], 'created')
    .endAsync('created') as Run<ReturnType<typeof createCode>>;

  const listPending = () => ({ ok: true as const, pending: pairing().listPending(now()) });
  const pending = (superpipe({})('device.pair.pending') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller): Gate<OperationCaller> =>
        isPhone(caller) ||
        (isLocal(caller) && caller.device?.kind === 'human' && pairing().terminalMayApprove())
          ? { value: caller }
          : { reason: { ok: false, reason: NEEDS_PAIRED_HUMAN } },
      'caller',
      'result:pending'
    )
    .pipe(listPending, 'caller', 'pending')
    .endAsync('pending') as Run<ReturnType<typeof listPending>>;

  const approve = (superpipe({})('device.pair.approve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitDecision(ALLOW_NEEDS_PAIRED_HUMAN, true), 'caller', 'result:approved')
    .pipe(
      (
        deviceId: string,
        input: { codeId: string; confirmCode?: string },
        caller: OperationCaller
      ) =>
        pairing().approveAsync({
          codeId: input.codeId,
          deviceId,
          door: fromDoor(caller),
          confirmCode: input.confirmCode,
          now: now(),
        }),
      ['approved', 'input', 'caller'],
      'decided'
    )
    .pipe(settleDecision(ALLOW_NEEDS_PAIRED_HUMAN), ['decided', 'input'], 'approved')
    .endAsync('approved') as Run<{ ok: true }>;

  const readTerminalApproval = () => ({ ok: true as const, enabled: pairing().terminalApproval() });
  const terminalApprovalGet = (superpipe({})('device.pair.terminal_approval.get') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocal, 'caller', 'result:approval')
    .pipe(readTerminalApproval, 'caller', 'approval')
    .endAsync('approval') as Run<ReturnType<typeof readTerminalApproval>>;

  const terminalApprovalSet = (superpipe({})('device.pair.terminal_approval.set') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocal, 'caller', 'result:approval')
    .pipe(
      (input: { enabled: boolean }, caller: OperationCaller): Gate<string> =>
        input.enabled && !isPhone(caller)
          ? { reason: { ok: false, reason: TERMINAL_APPROVAL_NEEDS_PHONE } }
          : { value: caller.device?.deviceId ?? caller.sessionId ?? caller.source },
      ['input', 'caller'],
      'result:approval'
    )
    .pipe(
      async (input: { enabled: boolean }, changedBy: string) =>
        (await pairing().setTerminalApprovalAsync(input.enabled, changedBy, now()))
          ? { ok: true as const, enabled: input.enabled }
          : { ok: false as const, reason: TERMINAL_APPROVAL_NEEDS_PHONE },
      ['input', 'approval'],
      'approval'
    )
    .endAsync('approval') as Run<{ ok: true; enabled: boolean }>;

  const deny = (superpipe({})('device.pair.deny') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitDecision(DENY_NEEDS_PAIRED_HUMAN, false), 'caller', 'result:denied')
    .pipe(
      (deviceId: string, input: { codeId: string }) =>
        pairing().denyAsync(input.codeId, deviceId, now()),
      ['denied', 'input'],
      'decided'
    )
    .pipe(settleDecision(DENY_NEEDS_PAIRED_HUMAN), ['decided', 'input'], 'denied')
    .endAsync('denied') as Run<{ ok: true }>;

  const listDevices = (caller: OperationCaller) => ({
    ok: true as const,
    devices: pairing()
      .listDevices()
      .map((device) => ({ ...device, current: device.id === caller.device?.deviceId })),
  });
  const list = (superpipe({})('device.list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocal, 'caller', 'result:devices')
    .pipe(
      (caller: OperationCaller): Gate<OperationCaller> =>
        fromDoor(caller) || isPairedHuman(caller)
          ? { value: caller }
          : { reason: { ok: false, reason: NEEDS_PAIRED_HUMAN } },
      'caller',
      'result:devices'
    )
    .pipe(listDevices, 'caller', 'devices')
    .endAsync('devices') as Run<ReturnType<typeof listDevices>>;

  const listUnpaired = () => ({ ok: true as const, connections: pairing().listUnpaired() });
  const unpaired = (superpipe({})('device.unpaired.list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocal, 'caller', 'result:connections')
    .pipe(listUnpaired, 'caller', 'connections')
    .endAsync('connections') as Run<ReturnType<typeof listUnpaired>>;

  const listWouldRefuse = () => ({ ok: true as const, requests: pairing().listWouldRefuse() });
  const wouldRefuse = (superpipe({})('device.would_refuse.list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocal, 'caller', 'result:requests')
    .pipe(listWouldRefuse, 'caller', 'requests')
    .endAsync('requests') as Run<ReturnType<typeof listWouldRefuse>>;

  const resetLockout = (superpipe({})('device.pair.reset_lockout') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocal, 'caller', 'result:reset')
    .pipe(
      () => {
        limiter.reset();
        return { ok: true as const };
      },
      'caller',
      'reset'
    )
    .endAsync('reset') as Run<{ ok: true }>;

  return [
    defineOperation({
      name: 'device.pair.create',
      description:
        'Make a single-use pairing code, valid 10 minutes, for a new device of the given kind. The local CLI makes the first device’s code; later codes need Allow from a paired human. Explicit local devices reset-human recovery permits one replacement human pairing without Allow. confirm two-way (human only) starts pending and needs the confirmation code shown on the phone typed on approval.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z
        .object({
          kind: Kind,
          name: z.string().trim().min(1).max(80).optional(),
          confirm: z.literal('two-way').optional(),
        })
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
      execute: (input, caller) => create(input, caller),
    }),
    defineOperation({
      name: 'device.pair.pending',
      description:
        'List issued codes waiting for Allow by an active paired human, or by the terminal while it may approve (never the codes themselves). Two-way codes report only whether the phone has confirmed; no confirmation code is returned.',
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
              requestedName: z.string().nullable(),
              expiresAt: z.number(),
              twoWay: z.boolean(),
              phoneConfirmed: z.boolean(),
            })
          ),
        }),
        Refused,
      ]),
      execute: (input, caller) => pending(input, caller),
    }),
    defineOperation({
      name: 'device.pair.approve',
      description:
        'Allow a pending pairing code so its device can pair. A two-way code needs confirmCode, the eight-letter confirmation code shown on the new phone; a wrong one denies the code. The terminal and local tools may allow only while terminal approval is on, or for the first device or recovery.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z
        .object({
          codeId: z.string().min(1),
          confirmCode: z.string().optional(),
        })
        .strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: (input, caller) => approve(input, caller),
    }),
    defineOperation({
      name: 'device.pair.terminal_approval.get',
      description:
        'Whether the terminal and local tools may allow device codes (two-way codes still need the confirmation code shown on the phone). On by default.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true), enabled: z.boolean() }), Refused]),
      execute: (input, caller) => terminalApprovalGet(input, caller),
    }),
    defineOperation({
      name: 'device.pair.terminal_approval.set',
      description:
        'Turn terminal approval of device codes on or off. Any local caller can turn it off; only a paired phone or browser can turn it back on.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({ enabled: z.boolean() }).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true), enabled: z.boolean() }), Refused]),
      execute: (input, caller) => terminalApprovalSet(input, caller),
    }),
    defineOperation({
      name: 'device.pair.deny',
      description: 'Deny a pending pairing code so its device can never pair with it.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({ codeId: z.string().min(1) }).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: (input, caller) => deny(input, caller),
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
      execute: (input, caller) => list(input, caller),
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
      execute: (input, caller) => unpaired(input, caller),
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
      execute: (input, caller) => wouldRefuse(input, caller),
    }),
    defineOperation({
      name: 'device.revoke',
      description:
        'Revoke a paired device: its credential stops working and its open connections close. Ordinary revocation never reopens pairing without Allow; the explicit lost-phone reset does.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({ deviceId: z.string().min(1) }).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: async (input, caller) => revoke(input.deviceId, caller),
    }),
    defineOperation({
      name: 'device.pair.reset_lockout',
      description: 'Reopen pairing after too many bad codes locked it.',
      policy: { safetyClass: 'human_only' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([z.object({ ok: z.literal(true) }), Refused]),
      execute: (input, caller) => resetLockout(input, caller),
    }),
  ];
}
