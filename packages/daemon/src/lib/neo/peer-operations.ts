import { createHash, randomBytes, randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { artifactIdentityWrites } from '../../storage/repositories/artifact-file-identity-write.ts';
import {
  peerReads,
  peerWrites,
  type NeoPeer,
} from '../../storage/repositories/neo-peer-repository.ts';
import { createCredentialStore } from '../credentials/credential-store.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationEntry,
} from '../operations/registry.ts';
import { receivedNeoHumanInput } from './human-input.ts';
import type { NeoService } from './service.ts';

const Name = z.string().trim().min(1).max(80);
const Identity = z.object({
  id: z.string(),
  name: Name,
  address: z.string().nullable(),
  receiving: z.boolean(),
});
const Refused = z.object({ accepted: z.literal(false), reason: z.string() });
const Accepted = z.object({ accepted: z.literal(true) });
const Code = z.string().min(1).max(64);
const Address = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  }, 'Use the peer HTTPS origin without credentials, a path, query or fragment.')
  .transform((value) => new URL(value).origin);
const Remote = z.object({ credential: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Failure = z.infer<typeof Refused>;
const refuse = (reason: string) => ({ reason: { accepted: false as const, reason } });
const peerIdentity = ({ id, name, address, credentialHash }: NeoPeer) => ({
  id,
  name,
  address,
  receiving: credentialHash !== null,
});

export async function readPeerPairingJson(
  body: ReadableStream<Uint8Array> | null
): Promise<unknown> {
  const reader = body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function createPeerOperations(service: NeoService) {
  const db = service.db.getDatabase(),
    gateway = gatewayFor(db);
  const secretAddress = async (id: string): Promise<[string, string]> => [
    `hyperneo.peer.${await gateway.call(artifactIdentityWrites, 'ensure', randomUUID())}.${id}`,
    'message',
  ];
  const facts = (caller: OperationCaller) => ({
    own: caller.role === 'neo' && caller.sessionId === service.repo.defaultBinding()?.sessionId,
    human:
      !!caller.sessionId &&
      !!caller.consumedInputId &&
      !!receivedNeoHumanInput(service, caller.sessionId, caller.consumedInputId),
  });
  const admit = (observed: ReturnType<typeof facts>, manage: boolean) =>
    !observed.own
      ? refuse('own_neo_required')
      : manage && !observed.human
        ? refuse('human_input_required')
        : { value: true as const };
  const begin = (verb: string) =>
    (superpipe({})(`neo.peer.${verb}`) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(facts, 'caller', 'facts')
      .pipe(
        (observed: ReturnType<typeof facts>) => admit(observed, verb !== 'list'),
        'facts',
        'result:admission'
      );
  type Pairing = {
    id: string;
    name: string;
    address: string;
    existing: boolean;
    ok: boolean;
    body: unknown;
  };
  async function fetchPairing({
    name,
    address,
    code,
  }: {
    name: string;
    address: string;
    code: string;
  }): Promise<Pairing> {
    const existing = await gateway.call(peerReads, 'named', name);
    const response = await fetch(new URL('/neo-peer/pair', address), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return {
      id: existing?.id ?? randomUUID(),
      existing: existing !== null,
      name,
      address,
      ok: response.ok,
      body: await readPeerPairingJson(response.body),
    };
  }
  const acceptCredential = (paired: Pairing) => {
    const parsed = Remote.safeParse(paired.body);
    return paired.ok && parsed.success
      ? { value: { ...paired, credential: parsed.data.credential } }
      : refuse('pairing_refused');
  };
  async function savePairing(paired: Pairing & { credential: string }) {
    const { id, name, address, credential, existing } = paired;
    const store = createCredentialStore(db),
      key = await secretAddress(id);
    const previous = await store.get(...key);
    try {
      await store.set(...key, JSON.stringify({ address, credential }));
      if (await gateway.call(peerWrites, 'connect', id, name, address, existing))
        return { accepted: true as const, id };
    } catch (error) {
      if (previous === null) await store.delete(...key);
      else await store.set(...key, previous);
      throw error;
    }
    await store.delete(...key);
    return { accepted: false as const, reason: 'relationship_changed' };
  }
  function operation<Input, Output>(
    verb: 'invite' | 'accept' | 'list' | 'remove',
    inputSchema: z.ZodType<Input>,
    output: z.ZodType<Output>,
    pipeline: PipelineAPI,
    description: string
  ): Omit<OperationEntry<Input, Output | Failure>, 'name'> {
    const run = pipeline.endAsync('admission') as (
      input: Input,
      caller: OperationCaller
    ) => Promise<Output | Failure>;
    return {
      description,
      inputSchema,
      resultSchema: z.union([output, Refused]),
      policy: { safetyClass: verb === 'list' ? 'read' : 'mutate', roles: ['neo'] },
      execute: (input, caller) => run(input, caller),
    };
  }
  return [
    defineOperation({
      name: 'neo.peer.invite',
      ...operation(
        'invite',
        z.object({ name: Name }).strict(),
        Accepted.extend({ id: z.string(), code: Code, expiresAt: z.number() }),
        begin('invite').pipe(
          async ({ name }: { name: string }) => {
            const code = randomBytes(16).toString('hex'),
              expiresAt = Date.now() + 600_000;
            const peer = await gateway.call(
              peerWrites,
              'invite',
              randomUUID(),
              name,
              createHash('sha256').update(code).digest('hex'),
              expiresAt
            );
            return { accepted: true, id: peer.id, code, expiresAt };
          },
          ['input', 'admission'],
          'admission'
        ),
        'Only on the current human request, allow a named peer to send text. Return a single-use ten-minute invitation for the human to share privately; it grants no device or RPC access.'
      ),
    }),
    defineOperation({
      name: 'neo.peer.accept',
      ...operation(
        'accept',
        z.object({ name: Name, address: Address, code: Code }).strict(),
        Accepted.extend({ id: z.string() }),
        begin('accept')
          .pipe(fetchPairing, ['input', 'admission'], 'pairing')
          .pipe(acceptCredential, 'pairing', 'result:admission')
          .pipe(savePairing, 'admission', 'admission'),
        'Only on the current human request, accept a peer invitation using its HTTPS address and a local contact name. Store the message-only credential privately; never expose it to the model.'
      ),
    }),
    defineOperation({
      name: 'neo.peer.list',
      ...operation(
        'list',
        z.object({}).strict(),
        Accepted.extend({ peers: z.array(Identity) }),
        begin('list').pipe(
          async () => ({
            accepted: true,
            peers: (await gateway.call(peerReads, 'list')).map(peerIdentity),
          }),
          'admission',
          'admission'
        ),
        'List this instance’s named peers and their outbound addresses, without invitations or credentials.'
      ),
    }),
    defineOperation({
      name: 'neo.peer.remove',
      ...operation(
        'remove',
        z.object({ id: z.string().min(1) }).strict(),
        Accepted,
        begin('remove').pipe(
          async ({ id }: { id: string }) => {
            await gateway.call(peerWrites, 'remove', id);
            await createCredentialStore(db).delete(...(await secretAddress(id)));
            return { accepted: true };
          },
          ['input', 'admission'],
          'admission'
        ),
        'Only on the current human request, remove a peer and its stored outbound credential. The removed peer has no further incoming access.'
      ),
    }),
  ];
}
