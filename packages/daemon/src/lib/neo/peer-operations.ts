import { neoToolDescription } from '@hyperneo/prompts';
import { randomBytes, randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { PeerMessage } from '../../routes/neo-peer-message.ts';
import { readBody } from '../../routes/neo-peer.ts';
import { artifactIdentityWrites } from '../../storage/repositories/artifact-file-identity-write.ts';
import { createCredentialStore } from '../credentials/credential-store.ts';
import { peerReads, peerWrites } from '../../storage/repositories/neo-peer-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { receivedNeoHumanInput } from './human-input.ts';
import type { NeoService } from './service.ts';

const Accepted = z.object({ accepted: z.literal(true) });
const Refused = z.object({ accepted: z.literal(false), reason: z.string() });
type Refusal = z.infer<typeof Refused>;
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
  }, 'Use the peer HTTPS origin without credentials, path, query or fragment.')
  .transform((value) => new URL(value).origin);
const Accept = z
  .object({
    name: z.string().trim().min(1).max(80),
    address: Address,
    code: z.string().min(1).max(64),
  })
  .strict();
const Remote = z.object({ credential: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const refuse = (reason: string) => ({ reason: { accepted: false as const, reason } });
function admit(own: boolean, human: boolean, manage: boolean) {
  if (own && (!manage || human)) return { value: true };
  return refuse(own ? 'human_ask_required' : 'main_neo_only');
}
export function createPeerOperations(service: NeoService) {
  const db = service.db.gateway;
  const secretAddress = async (id: string): Promise<[string, string]> => [
    `hyperneo.peer.${await db.call(artifactIdentityWrites, 'ensure', randomUUID())}.${id}`,
    'message',
  ];
  const facts = ({ sessionId = '', consumedInputId = '', role }: OperationCaller) => ({
    own: role === 'neo' && sessionId === service.repo.defaultBinding()?.sessionId,
    human: !!receivedNeoHumanInput(service, sessionId, consumedInputId),
  });
  const run = <I, O>(name: string, effect: (input: I) => Promise<O>, manage = true) =>
    (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(facts, 'caller', 'facts')
      .pipe(
        ({ own, human }: ReturnType<typeof facts>) => admit(own, human, manage),
        'facts',
        'result:answer'
      )
      .pipe(effect, ['input', 'answer'], 'answer')
      .endAsync('answer') as (input: I, caller: OperationCaller) => Promise<O | Refusal>;
  const policy = { safetyClass: 'mutate' as const, roles: ['neo'] as const };
  async function fetchPairing(input: z.infer<typeof Accept>) {
    const existing = await db.call(peerReads, 'named', input.name);
    const response = await fetch(new URL('/neo-peer/pair', input.address), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.code }),
    });
    return {
      ...input,
      id: existing?.id ?? randomUUID(),
      existing: existing !== null,
      ok: response.ok,
      body: await readBody(response),
    };
  }
  type Pairing = Awaited<ReturnType<typeof fetchPairing>>;
  const credential = (paired: Pairing) => {
    const parsed = Remote.safeParse(paired.body);
    return paired.ok && parsed.success
      ? { value: { ...paired, credential: parsed.data.credential } }
      : refuse('pairing_refused: Check the HTTPS address and use a fresh invitation.');
  };
  async function save(paired: Pairing & { credential: string }) {
    const { id, name, address, credential, existing } = paired;
    const store = createCredentialStore(service.db.getDatabase()),
      key = await secretAddress(id);
    const previous = await store.get(...key);
    try {
      await store.set(...key, JSON.stringify({ address, credential }));
      if (await db.call(peerWrites, 'connect', id, name, address, existing))
        return { accepted: true as const, id };
    } catch (error) {
      if (previous === null) await store.delete(...key);
      else await store.set(...key, previous);
      throw error;
    }
    await store.delete(...key);
    return {
      accepted: false as const,
      reason:
        'relationship_changed: Read the current contacts and ask the human before pairing again.',
    };
  }
  const Send = PeerMessage.extend({ id: z.string().min(1) });
  const unavailable = () =>
    refuse('peer_unavailable: List contacts and pair with the intended recipient before sending.');
  const loadPeer = (input: z.infer<typeof Send>) => db.call(peerReads, 'byId', input.id);
  type Destination = NonNullable<Awaited<ReturnType<typeof loadPeer>>>;
  async function postMessage(peer: Destination, input: z.infer<typeof Send>, secret: string) {
    try {
      const response = await fetch(new URL('/neo-peer/message', peer.address!), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ requestId: input.requestId, content: input.content }),
      });
      const receipt = z
        .object({ accepted: z.literal(true) })
        .strict()
        .safeParse(await readBody(response));
      if (response.ok && receipt.success) return { accepted: true as const };
    } catch {}
    return {
      accepted: false as const,
      reason:
        'delivery_unconfirmed: The recipient has not confirmed receipt. Retry only with the same requestId and content; do not claim it was read.',
    };
  }
  return [
    defineOperation({
      name: 'neo.peer.accept',
      description: neoToolDescription('neo.peer.accept'),
      policy,
      inputSchema: Accept,
      resultSchema: z.union([Accepted.extend({ id: z.string() }), Refused]),
      execute: (superpipe({})('neo.peer.accept') as PipelineAPI)
        .input(['input', 'caller'])
        .pipe(facts, 'caller', 'facts')
        .pipe(
          ({ own, human }: ReturnType<typeof facts>) => admit(own, human, true),
          'facts',
          'result:answer'
        )
        .pipe(fetchPairing, ['input', 'answer'], 'paired')
        .pipe(credential, 'paired', 'result:answer')
        .pipe(save, 'answer', 'answer')
        .endAsync('answer') as (
        input: z.infer<typeof Accept>,
        caller: OperationCaller
      ) => Promise<Awaited<ReturnType<typeof save>> | Refusal>,
    }),
    defineOperation({
      name: 'neo.peer.invite',
      description: neoToolDescription('neo.peer.invite'),
      policy,
      inputSchema: z.object({ name: z.string().trim().min(1).max(80) }).strict(),
      resultSchema: z.union([
        Accepted.extend({ id: z.string(), code: z.string(), expiresAt: z.number() }),
        Refused,
      ]),
      execute: run('neo.peer.invite', async ({ name }: { name: string }) => {
        const code = randomBytes(16).toString('hex'),
          expiresAt = Date.now() + 600_000;
        const { id } = await db.call(peerWrites, 'invite', randomUUID(), name, code, expiresAt);
        return { accepted: true as const, id, code, expiresAt };
      }),
    }),
    defineOperation({
      name: 'neo.peer.list',
      description: neoToolDescription('neo.peer.list'),
      policy: { ...policy, safetyClass: 'read' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        Accepted.extend({
          peers: z.array(
            z.object({ id: z.string(), name: z.string(), address: z.string().nullable() })
          ),
        }),
        Refused,
      ]),
      execute: run(
        'neo.peer.list',
        async () => ({ accepted: true as const, peers: await db.call(peerReads, 'list') }),
        false
      ),
    }),
    defineOperation({
      name: 'neo.peer.remove',
      description: neoToolDescription('neo.peer.remove'),
      policy,
      inputSchema: z.object({ id: z.string().min(1) }).strict(),
      resultSchema: z.union([Accepted, Refused]),
      execute: run('neo.peer.remove', async ({ id }: { id: string }) => {
        await createCredentialStore(service.db.getDatabase()).delete(...(await secretAddress(id)));
        await db.call(peerWrites, 'remove', id);
        return { accepted: true as const };
      }),
    }),
    defineOperation({
      name: 'neo.peer.send',
      description: neoToolDescription('neo.peer.send'),
      policy,
      inputSchema: Send,
      resultSchema: z.union([Accepted, Refused]),
      execute: (superpipe({})('neo.peer.send') as PipelineAPI)
        .input(['input', 'caller'])
        .pipe(facts, 'caller', 'facts')
        .pipe(
          ({ own, human }: ReturnType<typeof facts>) => admit(own, human, true),
          'facts',
          'result:answer'
        )
        .pipe(loadPeer, ['input', 'answer'], 'peer')
        .pipe(
          (peer: Awaited<ReturnType<typeof loadPeer>>) =>
            peer?.address ? { value: peer } : unavailable(),
          'peer',
          'result:answer'
        )
        .pipe(
          async (peer: Destination) =>
            createCredentialStore(service.db.getDatabase()).get(...(await secretAddress(peer.id))),
          'answer',
          'secret'
        )
        .pipe(
          (secret: string | null, peer: Destination) => {
            const parsed = Remote.extend({ address: Address }).safeParse(
              secret ? JSON.parse(secret) : null
            );
            return parsed.success && parsed.data.address === peer.address
              ? { value: parsed.data.credential }
              : unavailable();
          },
          ['secret', 'answer'],
          'result:answer'
        )
        .pipe(
          (secret: string, peer: Destination, input: z.infer<typeof Send>) =>
            postMessage(peer, input, secret),
          ['answer', 'peer', 'input'],
          'answer'
        )
        .endAsync('answer') as (
        input: z.infer<typeof Send>,
        caller: OperationCaller
      ) => Promise<Awaited<ReturnType<typeof postMessage>> | Refusal>,
    }),
  ];
}
