import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type {
  ClientRegistration,
  ClientRegistrationRepository,
} from '../../storage/repositories/client-registration-repository.ts';
import { requireLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };

const CLIENT_DATA_MAX_BYTES = 8192;
const ClientId = z.string().trim().min(1).max(200);
const Kind = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'kind is up to 40 letters, digits, dots, dashes');
const Register = z.object({
  clientId: ClientId,
  kind: Kind,
  data: z.record(z.string(), z.unknown()),
});
const Unregister = z.object({ clientId: ClientId, kind: Kind.optional() });
const List = z.object({ kind: Kind.optional() });
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
const Registered = z.union([Failure, z.object({ ok: z.literal(true) })]);
const Removed = z.union([Failure, z.object({ ok: z.literal(true), removed: z.number() })]);
const Listed = z.union([
  Failure,
  z.object({
    ok: z.literal(true),
    clients: z.array(
      z.object({
        clientId: z.string(),
        kind: z.string(),
        data: z.record(z.string(), z.unknown()),
        updatedAt: z.number(),
      })
    ),
  }),
]);

export function requireClientData(
  input: z.infer<typeof Register>,
  now: number
): Gate<ClientRegistration> {
  const bytes = Buffer.byteLength(JSON.stringify(input.data));
  return bytes <= CLIENT_DATA_MAX_BYTES
    ? { value: { ...input, updatedAt: now } }
    : {
        reason: {
          ok: false,
          reason: `data_too_large: ${bytes} bytes; the limit is ${CLIENT_DATA_MAX_BYTES}.`,
        },
      };
}

export function createClientOperations(clients: ClientRegistrationRepository) {
  const register = (superpipe({})('client.register') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocalUser, 'caller', 'result:admission')
    .pipe(() => Date.now(), 'input', 'now')
    .pipe(requireClientData, ['input', 'now'], 'result:admission')
    .pipe(
      (registration: ClientRegistration) => {
        clients.register(registration);
        return { ok: true as const };
      },
      'admission',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof Register>,
    caller: OperationCaller
  ) => z.infer<typeof Registered>;
  const unregister = (superpipe({})('client.unregister') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocalUser, 'caller', 'result:admission')
    .pipe(
      (input: z.infer<typeof Unregister>) => ({
        ok: true as const,
        removed: clients.unregister(input.clientId, input.kind),
      }),
      'input',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof Unregister>,
    caller: OperationCaller
  ) => z.infer<typeof Removed>;
  const list = (superpipe({})('client.list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(requireLocalUser, 'caller', 'result:admission')
    .pipe(
      (input: z.infer<typeof List>) => ({ ok: true as const, clients: clients.list(input.kind) }),
      'input',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof List>,
    caller: OperationCaller
  ) => z.infer<typeof Listed>;
  const policy = { safetyClass: 'human_only' as const };
  return [
    defineOperation({
      name: 'client.list',
      description:
        'List companion client registrations, optionally of one kind, newest first. User only.',
      inputSchema: List,
      resultSchema: Listed,
      policy,
      execute: async (input, caller) => list(input, caller),
    }),
    defineOperation({
      name: 'client.register',
      description:
        'Save or replace a companion client registration keyed by clientId and kind. data is an opaque JSON object of up to 8 KB. User only.',
      inputSchema: Register,
      resultSchema: Registered,
      policy,
      execute: async (input, caller) => register(input, caller),
    }),
    defineOperation({
      name: 'client.unregister',
      description:
        "Remove a companion client's registration of one kind, or all of its kinds. User only.",
      inputSchema: Unregister,
      resultSchema: Removed,
      policy,
      execute: async (input, caller) => unregister(input, caller),
    }),
  ];
}
