import { withMintedPublicationId } from '../../../helpers/neo-minted-publication.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { requireNeoCrossProjectParts } from '../../../../src/lib/neo/cross-project-operation.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { neoCrossProjectReplyId } from '../../../../src/storage/repositories/neo-cross-project-repository.ts';

let db: Database;
let service: NeoService;
let registry: OperationRegistry;
let root: string;
let messageId: string;
let workA: string;
let workB: string;
let live: boolean;
let manager: SessionManager;
const events = new InternalEventBus<DaemonInternalEventMap>();
const hub = { event: () => {} } as unknown as MessageHub;
const rootCaller = (id = messageId): OperationCaller => ({
  source: 'mcp',
  role: 'neo',
  sessionId: root,
  neoTurn: { messageId: id, human: id === messageId, isLive: () => live },
});
const parts = () => [
  { projectId: 'alpha', quote: `Review ${workA}`, question: `Review ${workA}` },
  { projectId: 'beta', quote: `review ${workB}`, question: `Review ${workB}` },
];
function savePrompt(sessionId: string, id: string) {
  db.getSDKMessageRepo().saveSDKMessage(sessionId, {
    type: 'user',
    uuid: id,
    session_id: sessionId,
    parent_tool_use_id: null,
    inputKind: 'system',
    message: { role: 'user', content: 'Runtime return' },
  } as SDKUserMessage);
}
const invoke = (name: string, input: unknown, caller = rootCaller()) =>
  invokeOperation(
    registry,
    name,
    name === 'neo.publication.publish'
      ? withMintedPublicationId(service, input as { publicationId?: string })
      : input,
    caller
  );

beforeEach(async () => {
  db = await createTestDb();
  live = true;
  manager = {
    createSession: async (params: { sessionId: string; title: string; workspacePath: string }) => {
      const session = createTestSession(params.sessionId);
      session.title = params.title;
      session.workspacePath = params.workspacePath;
      db.createSession(session);
      return params.sessionId;
    },
    getOperationRegistry: () => registry,
  } as unknown as SessionManager;
  service = new NeoService(db, manager, hub, events);
  for (const id of ['alpha', 'beta'])
    service.repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
  root = await service.open(null);
  registry = createOperationRegistry(createNeoOperations(service));
  workA = crypto.randomUUID();
  workB = crypto.randomUUID();
  messageId = crypto.randomUUID();
  for (const [id, projectId] of [
    [workA, 'alpha'],
    [workB, 'beta'],
  ])
    service.repo.proposeWork({
      id,
      requestKey: id,
      projectId,
      originSessionId: root,
      title: id,
      instruction: 'Review',
    });
  expect(
    await invoke(
      'neo.message.send',
      { sessionId: root, requestId: messageId, content: `Review ${workA}, and review ${workB}.` },
      { source: 'rpc', principal: 'local' }
    )
  ).toMatchObject({ kind: 'completed', value: { ok: true } });
});
afterEach(() => {
  service.dispose();
  db.close();
});

describe('Cross-project runtime', () => {
  test('quotes each part privately and delivers exactly one aggregate after service restart', async () => {
    const result = await invoke('neo.projects.dispatch', { parts: parts() });
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
    const group = service.crossProjects.forAsk({ sessionId: root, messageId })!;
    expect(group).not.toBeNull();
    const members = service.crossProjects.members(group);
    const [first, second] = members;
    const request = service.consultations.get(first.id)!;
    expect(request.originMessageId).toBe(messageId);
    expect(request.question).toContain(
      parts().find((part) => part.projectId === first.projectId)!.quote
    );
    expect(request.question).not.toContain('humanMessageId');
    const draft = {
      publicationId: crypto.randomUUID(),
      shortText: 'Here are both findings.',
      fullText: 'Both findings are available.',
      links: [],
    };
    expect(await invoke('neo.publication.publish', draft)).toMatchObject({
      kind: 'completed',
      value: { accepted: true, created: true },
    });
    savePrompt(request.sessionId, `neo-consult:${first.id}:request`);
    const holder: OperationCaller = {
      source: 'mcp',
      role: 'neo',
      sessionId: request.sessionId,
      neoTurn: {
        messageId: `neo-consult:${first.id}:request`,
        consultationId: first.id,
        human: false,
        isLive: () => true,
      },
    };
    expect(await invoke('neo.publication.publish', draft, holder)).toMatchObject({
      kind: 'completed',
      value: { accepted: false, reason: 'consultation_answer' },
    });
    expect(
      await invoke('neo.project.respond', { id: first.id, answer: 'Alpha finding' }, holder)
    ).toMatchObject({ kind: 'completed', value: { ok: true } });
    const replyId = neoCrossProjectReplyId(group);
    const queued = () =>
      db.getJobQueueRepo().listActiveByPayload('mailbox', { messageUuid: replyId });
    expect(queued()).toHaveLength(0);
    service.dispose();
    service = new NeoService(db, manager, hub, events);
    registry = createOperationRegistry(createNeoOperations(service));
    await service.recoverConsultations();
    expect(queued()).toHaveLength(0);
    const next = service.consultations.get(second.id)!;
    savePrompt(next.sessionId, `neo-consult:${second.id}:request`);
    expect(
      await invoke(
        'neo.project.respond',
        { id: second.id, answer: 'Beta finding' },
        {
          source: 'mcp',
          role: 'neo',
          sessionId: next.sessionId,
          neoTurn: {
            messageId: `neo-consult:${second.id}:request`,
            consultationId: second.id,
            human: false,
            isLive: () => true,
          },
        }
      )
    ).toMatchObject({ kind: 'completed', value: { ok: true } });
    await service.recoverConsultations();
    await service.recoverConsultations();
    expect(queued()).toHaveLength(1);
    savePrompt(root, replyId);
    expect(await invoke('neo.publication.publish', draft, rootCaller(replyId))).toMatchObject({
      kind: 'completed',
      value: { accepted: true },
    });
    expect(service.crossProjects.forAsk({ sessionId: root, messageId })?.publicationId).toBe(
      service.publications.list(root.slice(4))?.at(-1)?.publicationId
    );
    expect(
      await invoke(
        'neo.publication.publish',
        {
          ...draft,
          publicationId: crypto.randomUUID(),
          shortText: 'A second final answer.',
          fullText: 'A different second final answer.',
        },
        rootCaller(replyId)
      )
    ).toMatchObject({
      kind: 'completed',
      value: { accepted: true, created: true },
    });
  });
  test('reuses the same group on retry and refuses changed or incomplete parts', async () => {
    const first = await invoke('neo.projects.dispatch', { parts: parts() });
    expect(await invoke('neo.projects.dispatch', { parts: [...parts()].reverse() })).toEqual(first);
    expect(service.crossProjects.pending()).toHaveLength(1);
    expect(await invoke('neo.projects.dispatch', { parts: [parts()[0]] })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('parts_must_cover_owners') },
    });
    expect(
      await invoke('neo.projects.dispatch', {
        parts: [{ ...parts()[0], question: 'Changed' }, parts()[1]],
      })
    ).toMatchObject({ value: { ok: false, reason: 'cross_project_conflict' } });
    expect(
      await invoke('neo.projects.dispatch', {
        parts: [{ ...parts()[0], question: `Review ${workB}` }, parts()[1]],
      })
    ).toMatchObject({ value: { ok: false, reason: 'part_references_another_owner' } });
  });
  test('returns failed parts once every owner is terminal', async () => {
    await invoke('neo.projects.dispatch', { parts: parts() });
    const group = service.crossProjects.forAsk({ sessionId: root, messageId })!;
    const [first, second] = service.crossProjects.members(group);
    const queued = () =>
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        messageUuid: neoCrossProjectReplyId(group),
      });
    service.consultations.finish(first.id, 'failed', 'Owner unavailable');
    await service.syncConsultation(first.id);
    expect(queued()).toHaveLength(0);
    service.consultations.finish(second.id, 'failed', 'Owner timed out');
    await service.recoverConsultations();
    await service.recoverConsultations();
    expect(queued()).toHaveLength(1);
    expect(service.crossProjects.ready(group)).toBe(true);
    expect(service.crossProjects.members(group).map((member) => member.answer)).toEqual([
      'Owner unavailable',
      'Owner timed out',
    ]);
  });
  test('refuses stale root input and non-root callers before creating a group', async () => {
    live = false;
    expect(await invoke('neo.projects.dispatch', { parts: parts() })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('live root') },
    });
    expect(service.crossProjects.pending()).toEqual([]);
    live = true;
    const holder = await service.open('alpha');
    expect(
      await invoke(
        'neo.projects.dispatch',
        { parts: parts() },
        { ...rootCaller(), sessionId: holder }
      )
    ).toMatchObject({ value: { ok: false, reason: 'Only root Neo can consult.' } });
    expect(service.crossProjects.pending()).toEqual([]);
  });
});

describe('requireNeoCrossProjectParts', () => {
  test('requires literal human quotes and unique existing owners', () => {
    expect(
      requireNeoCrossProjectParts(
        [
          { projectId: 'alpha', quote: 'invented', question: 'Review' },
          { projectId: 'beta', quote: 'beta', question: 'Review' },
        ],
        'alpha beta',
        ['alpha', 'beta'],
        () => true
      )
    ).toMatchObject({ reason: { reason: 'quote_must_match_human' } });
    expect(
      requireNeoCrossProjectParts(
        [
          { projectId: 'alpha', quote: 'alpha', question: 'Review' },
          { projectId: 'alpha', quote: 'alpha', question: 'Review' },
        ],
        'alpha beta',
        ['alpha', 'beta'],
        () => true
      )
    ).toMatchObject({ reason: { reason: 'invalid_project_owners' } });
  });
});
