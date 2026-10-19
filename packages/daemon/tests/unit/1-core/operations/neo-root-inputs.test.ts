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
});
