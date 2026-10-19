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
import { NEO_SINGLE_SESSION } from '../../../../src/lib/neo/consultation-origin.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

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
  root = await service.open();
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
  test('refuses with single_session and starts no group or consultation', async () => {
    expect(await invoke('neo.projects.dispatch', { parts: parts() })).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: NEO_SINGLE_SESSION },
    });
    expect(service.crossProjects.pending()).toEqual([]);
    expect(service.consultations.unsettled()).toEqual([]);
  });
  test('refuses a stale input before creating a group', async () => {
    live = false;
    expect(await invoke('neo.projects.dispatch', { parts: parts() })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('live Neo') },
    });
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
