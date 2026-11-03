import { randomBytes, randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { peerReads, peerWrites } from '../../storage/repositories/neo-peer-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { receivedNeoHumanInput } from './human-input.ts';
import type { NeoService } from './service.ts';

const Accepted = z.object({ accepted: z.literal(true) });
const Refused = z.object({ accepted: z.literal(false), reason: z.string() });
type Refusal = z.infer<typeof Refused>;
const refuse = (reason: string) => ({ reason: { accepted: false as const, reason } });
function admit(own: boolean, human: boolean, manage: boolean) {
  if (own && (!manage || human)) return { value: true };
  return refuse(own ? 'human_ask_required' : 'main_neo_only');
}
export function createPeerOperations(service: NeoService) {
  const db = service.db.gateway;
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
  return [
    defineOperation({
      name: 'neo.peer.invite',
      description: 'Invite a contact on the current human request; grants text delivery only.',
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
      description: 'List this instance’s contacts without invitations or credentials.',
      policy: { ...policy, safetyClass: 'read' },
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        Accepted.extend({ peers: z.array(z.object({ id: z.string(), name: z.string() })) }),
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
      description: 'On the current human request, remove a contact and revoke its incoming token.',
      policy,
      inputSchema: z.object({ id: z.string().min(1) }).strict(),
      resultSchema: z.union([Accepted, Refused]),
      execute: run('neo.peer.remove', async ({ id }: { id: string }) => {
        await db.call(peerWrites, 'remove', id);
        return { accepted: true as const };
      }),
    }),
  ];
}
