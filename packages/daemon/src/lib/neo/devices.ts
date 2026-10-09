import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type {
  NeoDevice,
  NeoDeviceRepository,
  NeoLiveActivity,
} from '../../storage/repositories/neo-device-repository.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };

const Token = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{16,512}$/, 'expected a hex APNs token');
const DeviceId = z.string().trim().min(1).max(200);
const Register = z.object({
  deviceId: DeviceId,
  apnsToken: Token,
  environment: z.enum(['sandbox', 'production']),
  bundleId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.-]{1,200}$/),
  pushToStartToken: Token.nullish(),
  kinds: z
    .array(z.enum(['needsYou', 'done', 'activity']))
    .default(['needsYou', 'done', 'activity']),
});
const Unregister = z.object({ deviceId: DeviceId });
const ActivityRegister = z.object({
  deviceId: DeviceId,
  activityId: z.string().trim().min(1).max(200),
  pushToken: Token,
});
const ActivityUnregister = z.object({
  deviceId: DeviceId,
  activityId: z.string().trim().min(1).max(200),
});
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const Registered = z.union([Failure, z.object({ ok: z.literal(true) })]);
const Removed = z.union([Failure, z.object({ ok: z.literal(true), removed: z.boolean() })]);

export function requireNeoUser(caller: OperationCaller): Gate<OperationCaller> {
  return caller.source === 'rpc' && caller.principal === 'local'
    ? { value: caller }
    : { reason: { ok: false, reason: 'This action needs the user.' } };
}

export function planNeoDevice(input: z.infer<typeof Register>): NeoDevice {
  return {
    deviceId: input.deviceId,
    apnsToken: input.apnsToken.toLowerCase(),
    environment: input.environment,
    bundleId: input.bundleId,
    pushToStartToken: input.pushToStartToken?.toLowerCase() ?? null,
    kinds: [...new Set(input.kinds)],
  };
}

export function requireNeoActivityDevice(
  device: { found: boolean },
  input: z.infer<typeof ActivityRegister>
): Gate<NeoLiveActivity> {
  return device.found
    ? {
        value: {
          deviceId: input.deviceId,
          activityId: input.activityId,
          pushToken: input.pushToken.toLowerCase(),
        },
      }
    : { reason: { ok: false, reason: `unknown_device: ${input.deviceId} is not registered.` } };
}

export function createNeoDeviceOperations(devices: NeoDeviceRepository) {
  const register = (superpipe({})('neo.device.register') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireNeoUser, 'caller', 'result:admission')
    .pipe(planNeoDevice, 'input', 'device')
    .pipe(
      (device: NeoDevice) => {
        devices.register(device, Date.now());
        return { ok: true as const };
      },
      'device',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof Register>,
    caller: OperationCaller
  ) => z.infer<typeof Registered>;
  const unregister = (superpipe({})('neo.device.unregister') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireNeoUser, 'caller', 'result:admission')
    .pipe(
      (input: z.infer<typeof Unregister>) => ({
        ok: true as const,
        removed: devices.unregister(input.deviceId),
      }),
      'input',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof Unregister>,
    caller: OperationCaller
  ) => z.infer<typeof Removed>;
  const registerActivity = (superpipe({})('neo.liveActivity.register') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireNeoUser, 'caller', 'result:admission')
    .pipe(
      (input: z.infer<typeof ActivityRegister>) => ({ found: !!devices.get(input.deviceId) }),
      'input',
      'device'
    )
    .pipe(requireNeoActivityDevice, ['device', 'input'], 'result:admission')
    .pipe(
      (activity: NeoLiveActivity) => {
        devices.registerActivity(activity, Date.now());
        return { ok: true as const };
      },
      'admission',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof ActivityRegister>,
    caller: OperationCaller
  ) => z.infer<typeof Registered>;
  const unregisterActivity = (superpipe({})('neo.liveActivity.unregister') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireNeoUser, 'caller', 'result:admission')
    .pipe(
      (input: z.infer<typeof ActivityUnregister>) => ({
        ok: true as const,
        removed: devices.unregisterActivity(input.deviceId, input.activityId),
      }),
      'input',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof ActivityUnregister>,
    caller: OperationCaller
  ) => z.infer<typeof Removed>;
  const policy = { safetyClass: 'human_only' as const };
  return [
    defineOperation({
      name: 'neo.device.register',
      description:
        'Register this phone for Neo push, for the user only. Re-registering a device replaces its tokens and kinds; a token already held by another device moves here.',
      inputSchema: Register,
      resultSchema: Registered,
      policy,
      execute: async (input, caller) => register(input, caller),
    }),
    defineOperation({
      name: 'neo.device.unregister',
      description: 'Stop Neo push to a device and forget its Live Activities, for the user only.',
      inputSchema: Unregister,
      resultSchema: Removed,
      policy,
      execute: async (input, caller) => unregister(input, caller),
    }),
    defineOperation({
      name: 'neo.liveActivity.register',
      description:
        "Record a running Live Activity's push token on a registered device, for the user only.",
      inputSchema: ActivityRegister,
      resultSchema: Registered,
      policy,
      execute: async (input, caller) => registerActivity(input, caller),
    }),
    defineOperation({
      name: 'neo.liveActivity.unregister',
      description: 'Forget a Live Activity that ended, for the user only.',
      inputSchema: ActivityUnregister,
      resultSchema: Removed,
      policy,
      execute: async (input, caller) => unregisterActivity(input, caller),
    }),
  ];
}
