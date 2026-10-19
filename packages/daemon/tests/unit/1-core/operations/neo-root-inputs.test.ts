import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder:fictional';
const ask = { sessionId: root, messageId: 'original-ask' };
const draft = {
  publicationId: '20000000-0000-4000-8000-000000000001',
  shortText: 'The fictional comparison is ready.',
  fullText: '**Source B** differs. Execution completion is not verified.',
  links: [],
};
describe('root Neo inputs', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;
  const prompt = (sessionId: string, messageId: string, inputKind: 'human' | 'system') => {
    expect(
      db.getSDKMessageRepo().saveSDKMessage(sessionId, {
        type: 'user',
        uuid: messageId,
        session_id: sessionId,
        parent_tool_use_id: null,
        inputKind,
        message: { role: 'user', content: 'Compare fictional sources.' },
      } as SDKUserMessage)
    ).toBe(true);
  };
  const ops = () => createOperationRegistry(createNeoOperations(service));
  const rootCaller = (messageId = ask.messageId, human = true) => ({
    source: 'mcp' as const,
    sessionId: root,
    role: 'neo' as const,
    neoTurn: { messageId, human, isLive: () => true },
  });
  beforeEach(async () => {
    db = await createTestDb();
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    events = new InternalEventBus();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      events
    );
    service.repo.saveProject({ id: 'fictional', title: 'Sources', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: holder, projectId: 'fictional', kind: 'project' });
    prompt(root, ask.messageId, 'human');
  });
  afterEach(() => {
    service.dispose();
    db.close();
    vi.restoreAllMocks();
  });

  test('a human message waiting while root works is steered into the running turn, never preempting it', async () => {
    const steerNeoInput = vi.fn(() => true);
    const handleInterrupt = vi.fn(async () => {});
    Object.assign(service.sessions, {
      getSessionForControl: vi.fn(async () => ({ steerNeoInput, handleInterrupt })),
    });
    prompt(root, 'waiting-human', 'human');
    db.getSDKMessageRepo().updateMessageStatus(
      [db.getSDKMessageRepo().findMessageIdByUuid(root, 'waiting-human')!],
      'enqueued'
    );
    await events.publish('session.updated', {
      sessionId: root,
      processingState: { status: 'idle' },
    });
    await service.steerHumanMessages(root);
    expect(steerNeoInput).not.toHaveBeenCalled();
    await events.publish('session.updated', {
      sessionId: root,
      processingState: { status: 'processing', messageId: 'note', phase: 'initializing' },
    });
    await vi.waitFor(() => expect(steerNeoInput).toHaveBeenCalledWith('waiting-human'));
    await service.steerHumanMessages(holder);
    expect(steerNeoInput).toHaveBeenCalledTimes(1);
    expect(handleInterrupt).not.toHaveBeenCalled();
  });

  test('an ask read lists what the human was actually told for it, and nothing else', async () => {
    const opened = service.askRecords.open(
      {
        id: 'ask-told',
        requestKey: 'ask-told',
        projectId: null,
        originSessionId: root,
        originMessageId: ask.messageId,
        title: 'Compare sources',
        ask: 'Compare sources',
        doneWhen: '- compared',
        doneSource: 'human',
      },
      [{ text: 'compared', check: null }]
    )!;
    const post = (publicationId: string, shortText: string, extra: object) =>
      service.publications.append({
        ...draft,
        publicationId,
        shortText,
        fullText: shortText,
        links: [],
        conversationId,
        askOrigin: ask,
        producerInput: ask,
        ...extra,
      });
    post('40000000-0000-4000-8000-000000000011', 'Reply to the ask.', {
      triggerId: `human:${ask.messageId}`,
    });
    post('40000000-0000-4000-8000-000000000012', 'The outcome.', {
      triggerId: `outcome:${opened.id}:x`,
    });
    post('40000000-0000-4000-8000-000000000013', 'Another ask.', {
      askOrigin: { sessionId: root, messageId: 'other' },
      producerInput: { sessionId: root, messageId: 'other' },
      triggerId: 'outcome:another:y',
    });
    expect(
      await invokeOperation(ops(), 'neo.snapshot', { askId: opened.id }, rootCaller())
    ).toMatchObject({
      value: {
        told: [
          { shortText: 'Reply to the ask.', triggerId: `human:${ask.messageId}` },
          { shortText: 'The outcome.', triggerId: `outcome:${opened.id}:x` },
        ],
      },
    });
  });

  test('an ask read keeps only the newest told messages, each short', async () => {
    const opened = service.askRecords.open(
      {
        id: 'ask-many',
        requestKey: 'ask-many',
        projectId: null,
        originSessionId: root,
        originMessageId: ask.messageId,
        title: 'Many',
        ask: 'Many',
        doneWhen: '- many',
        doneSource: 'human',
      },
      [{ text: 'many', check: null }]
    )!;
    for (let n = 0; n < 25; n++)
      service.publications.append({
        ...draft,
        publicationId: `40000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
        shortText: `${n} ${'x'.repeat(400)}`,
        fullText: `${n}`,
        links: [],
        conversationId,
        askOrigin: ask,
        producerInput: ask,
        triggerId: `outcome:${opened.id}:${n}`,
      });
    const read = (await invokeOperation(
      ops(),
      'neo.snapshot',
      { askId: opened.id },
      rootCaller()
    )) as { value: { told: { shortText: string }[] } };
    expect(read.value.told).toHaveLength(20);
    expect(read.value.told[0].shortText.startsWith('5 ')).toBe(true);
    expect(read.value.told.every((item) => item.shortText.length <= 300)).toBe(true);
  });
});
