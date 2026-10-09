import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { planNeoSavedRules, withNeoSavedRules } from '../../../../src/lib/neo/saved-rules.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const rule = 'HyperNeo code is done when merged to dev, as with #5555.';
const reply: NeoPublicationInput = {
  conversationId,
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: root, messageId: 'ask-1' },
  producerInput: { sessionId: root, messageId: 'ask-1' },
  shortText: 'Started #5559 in ~/focus/neokai.',
  fullText: 'Started #5559 in ~/focus/neokai on a worktree.',
  links: [],
};

describe('planNeoSavedRules', () => {
  test.each<[string, string[], string[], string[]]>([
    ['a new rule', ['Keep A.'], ['Keep A.', 'Keep B.'], ['Keep B.']],
    ['a reworded rule', ['Keep A.'], ['Keep A, always.'], ['Keep A, always.']],
    ['only removals', ['Keep A.', 'Keep B.'], ['Keep A.'], []],
  ])('%s', (_label, before, after, saved) => {
    expect(planNeoSavedRules(before, after)).toEqual(saved);
  });
});

describe('withNeoSavedRules', () => {
  test.each<[string, NeoPublicationInput, string[], string, string]>([
    ['nothing saved', reply, [], reply.shortText, reply.fullText],
    [
      'a saved rule',
      reply,
      [rule],
      `${reply.shortText}\n\nSaved: ${rule}`,
      `${reply.fullText}\n\nSaved: ${rule}`,
    ],
    [
      'a reply that already says it',
      { ...reply, shortText: `Started #5559.\nSaved: ${rule}` },
      [rule],
      `Started #5559.\nSaved: ${rule}`,
      `${reply.fullText}\n\nSaved: ${rule}`,
    ],
    ['an interim update', { ...reply, interim: true }, [rule], reply.shortText, reply.fullText],
  ])('%s', (_label, input, saved, shortText, fullText) => {
    expect(withNeoSavedRules(input, saved)).toMatchObject({ shortText, fullText });
  });

  test('keeps the short text within its limit', () => {
    const long = withNeoSavedRules({ ...reply, shortText: 'x'.repeat(1990) }, [rule]).shortText;
    expect(long).toHaveLength(2000);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('Neo reply after a rule save', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const caller: OperationCaller = {
    source: 'mcp',
    sessionId: root,
    role: 'neo',
    neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
  };

  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession(root));
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', concernId: null });
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: 'ask-1',
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'fix HyperNeo #5559' },
    } as unknown as SDKUserMessage);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  const invoke = (name: string, input: unknown, as = caller) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, as);

  test('the published reply names the rule this turn saved, and a retry stays identical', async () => {
    db.updateGlobalSettings({ neo: { standingRules: ['Ask before deleting anything.'] } });
    await invoke('neo.rule.save', { rules: ['Ask before deleting anything.', rule] });
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;

    expect(await invoke('neo.publication.publish', draft)).toMatchObject({
      value: { accepted: true, created: true },
    });
    expect(service.publications.get(conversationId, reply.publicationId)).toMatchObject({
      shortText: `${reply.shortText}\n\nSaved: ${rule}`,
    });
    expect(await invoke('neo.publication.publish', draft)).toMatchObject({
      value: { accepted: true, created: false },
    });
  });

  test('a turn that saved nothing publishes its reply unchanged', async () => {
    await invoke(
      'neo.rule.save',
      { rules: [rule] },
      {
        ...caller,
        neoTurn: { ...caller.neoTurn!, messageId: 'earlier-ask' },
      }
    );
    const { conversationId: _c, askOrigin: _a, producerInput: _p, ...draft } = reply;
    await invoke('neo.publication.publish', draft);
    expect(service.publications.get(conversationId, reply.publicationId)?.shortText).toBe(
      reply.shortText
    );
  });
});
