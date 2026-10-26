import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAFT_CHAR_LIMIT, MessageHub, WebSocketClientTransport } from '../../../shared/src/mod.ts';
import type { NeoConversationAsk } from '../../../shared/src/types/neo-conversation-ask.ts';
import type { NeoPreviewReference } from '../../../shared/src/types/neo-preview-context.ts';
import { createDaemonApp } from '../../src/app.ts';
import { getConfig } from '../../src/config.ts';
import { NeoAskTodoRepository } from '../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../src/storage/repositories/neo-todo-session-repository.ts';
import {
  createNeoDraftReloadBuffer,
  neoDraftRecoveryInput,
} from '../../../web/src/neo/neo-draft-reload-buffer.ts';
import {
  createNeoIntakeClient,
  type NeoPendingAsk,
  submitNeoDraft,
} from '../../../web/src/neo/neo-intake.ts';
import { presentConversationAskPage } from '../../../web/src/neo/conversation-ask-client.ts';
import { attachmentMessage, readNeoAttachment } from '../../../web/src/neo/neo-attachments.ts';
import { createVoicePreviewProof } from '../../../web/src/lib/voice/__tests__/voice-preview-proof.ts';

const run = realpathSync(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const seed = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(
      new URL('../../../../.claude/skills/verify/preview-register.ts', import.meta.url)
    ),
    run,
    'seed',
  ],
  { env: process.env, stdout: 'pipe', stderr: 'pipe' }
);
assert.equal(await seed.exited, 0, await new Response(seed.stderr).text());
const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const requestId = '20000000-0000-4000-8000-000000000001';
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let hub: MessageHub;
let voiceProof: Awaited<ReturnType<typeof createVoicePreviewProof>> | undefined;
const evidence: Record<string, unknown> = { providerTurns: 0, guiTests: false };
async function start() {
  app = await createDaemonApp({
    config: getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
    standalone: false,
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.initialize();
}
async function stop() {
  await transport?.close();
  transport = undefined;
  await app?.cleanup();
  app = undefined;
}
function database() {
  assert(app);
  return app.db;
}
const rpc = <T>(name: string, input: unknown) =>
  hub.request<T>('operation.invoke', { name, input });
try {
  await start();
  await database().createSession({
    id: sessionId,
    title: 'Synthetic Preview context',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  assert(
    new NeoRepository(database().getDatabase()).reserveBinding({
      sessionId,
      kind: 'neo',
      projectId: null,
    })
  );
  const work = new NeoAskTodoRepository(database().getDatabase());
  work.openAsk({
    id: 'preview-ask',
    sessionId,
    projectId: null,
    originMessageId: 'source',
    title: 'Preview context',
    request: 'Discuss this registered report',
    createdAt: 1,
  });
  work.addTodo(
    'preview-todo',
    'preview-ask',
    { title: 'Report', doneWhen: '', check: null, instruction: '', named: null },
    1
  );
  const owners = new NeoTodoSessionRepository(database().getDatabase());
  owners.create('preview-todo', {
    verb: 'start',
    adapter: 'hyperneo',
    place: { machine: 'synthetic', name: 'Synthetic', folder: join(run, 'workspace') },
  });
  owners.recordRef('preview-todo', { adapter: 'hyperneo', id: 'worker' });
  const registration = await rpc<{ accepted: boolean; artifact: { artifactId: string } }>(
    'artifact.file.register',
    {
      requestId: 'context-register',
      context: { kind: 'todo', id: 'preview-todo' },
      path: 'report.md',
      title: 'Synthetic Preview report',
    }
  );
  assert.equal(registration.accepted, true);
  const artifactId = registration.artifact.artifactId;
  const metadata = await rpc<{ accepted: boolean; metadata: { sha256: string } }>(
    'artifact.file.get',
    { artifactId }
  );
  assert.equal(metadata.accepted, true);
  const previewContext = { artifactId, snapshot: metadata.metadata.sha256 };
  const reference: NeoPreviewReference = {
    ...previewContext,
    displayName: 'Synthetic Preview report',
    state: 'available',
  };
  voiceProof = await createVoicePreviewProof(sessionId, reference);
  await voiceProof.send(hub);
  const input = {
    sessionId,
    requestId,
    content: 'Please discuss this exact snapshot.',
    previewContext,
  };
  const first = await submitNeoDraft(
    { sessionId, requestId, text: input.content, previewContext: reference },
    async () => hub
  );
  assert(first.ok && first.created);
  assert.deepEqual(first.previewContext, reference);
  assert(!JSON.stringify(first).includes('sourcePath'));
  assert(!JSON.stringify(first).includes(run));
  const captures = new Map<string, string>();
  const captureStorage: Storage = {
    get length() {
      return captures.size;
    },
    getItem: (key) => captures.get(key) ?? null,
    setItem: (key, value) => {
      captures.set(key, value);
    },
    key: (index) => [...captures.keys()][index] ?? null,
    removeItem: (key) => {
      captures.delete(key);
    },
    clear: () => captures.clear(),
  };
  const reload = createNeoDraftReloadBuffer(() => captureStorage);
  assert(reload.remember(sessionId, input.content, '', reference));
  const captured = createNeoDraftReloadBuffer(() => captureStorage).read(sessionId)!;
  assert.deepEqual(captured.previewContext, reference);
  assert.equal(
    reload.remember(
      sessionId,
      '\n'.repeat(DRAFT_CHAR_LIMIT),
      'b'.repeat(DRAFT_CHAR_LIMIT),
      reference
    ),
    false
  );
  assert.deepEqual(reload.read(sessionId), captured);
  const recovery = neoDraftRecoveryInput(captured);
  assert.deepEqual(recovery.previewContext, previewContext);
  const submitted = await rpc<{ ok: boolean; reason?: string }>('neo.draft.recover', recovery);
  assert(!submitted.ok && submitted.reason === 'submitted');
  assert(reload.remember(sessionId, input.content, '', null));
  const unbound = reload.read(sessionId)!;
  assert.equal(unbound.previewContext, null);
  const unboundInput = neoDraftRecoveryInput(unbound);
  assert((await rpc<{ ok: boolean }>('neo.draft.recover', unboundInput)).ok);
  assert(
    (
      await rpc<{ ok: boolean }>('neo.draft.recover', {
        ...unboundInput,
        base: 'older synthetic base',
      })
    ).ok
  );
  assert(reload.remember(sessionId, input.content, input.content));
  const legacyInput = neoDraftRecoveryInput(reload.read(sessionId)!);
  assert(!('previewContext' in legacyInput));
  const legacyRecovery = await rpc<{ ok: boolean; reason?: string }>(
    'neo.draft.recover',
    legacyInput
  );
  assert(!legacyRecovery.ok && legacyRecovery.reason === 'submitted');

  await hub.request('session.update', { sessionId, metadata: { inputDraftVoicePending: null } });
  const pendingVoice = 'Independent staged voice after a send';
  await hub.request('session.appendVoiceDraft', {
    sessionId,
    text: pendingVoice,
    dedupId: 'handoff-voice',
  });
  const clearedRecovery = await hub.request<{ cleared: boolean }>('session.clearInputDraftIf', {
    sessionId,
    expected: input.content,
  });
  assert(clearedRecovery.cleared);
  const afterClear = await hub.request<{
    session: { metadata: { inputDraft?: string; inputDraftVoicePending?: string } };
  }>('session.get', { sessionId });
  assert.equal(database().captureSessionInputDraft(sessionId)?.draft, null);
  assert.equal(afterClear.session.metadata.inputDraft, pendingVoice);
  assert.equal(afterClear.session.metadata.inputDraftVoicePending, pendingVoice);
  await hub.request('session.update', {
    sessionId,
    metadata: { inputDraft: 'Newer manual draft' },
  });
  const staleClear = await hub.request<{ cleared: boolean }>('session.clearInputDraftIf', {
    sessionId,
    expected: input.content,
  });
  assert.equal(staleClear.cleared, false);
  const newerDraft = await hub.request<{ session: { metadata: { inputDraft?: string } } }>(
    'session.get',
    { sessionId }
  );
  assert.equal(database().captureSessionInputDraft(sessionId)?.draft, 'Newer manual draft');
  assert(newerDraft.session.metadata.inputDraft?.includes('Newer manual draft'));
  await hub.request('session.update', {
    sessionId,
    metadata: { inputDraft: null, inputDraftVoicePending: null },
  });

  async function readContext() {
    const asks = await rpc<{ ok: boolean; items: NeoConversationAsk[] }>(
      'neo.conversation.asks.read',
      { conversationId, imageRefs: true }
    );
    const conversation = await rpc<{
      ok: boolean;
      items: { role: string; ask?: NeoConversationAsk }[];
    }>('neo.conversation.read', { conversationId });
    assert(asks.ok && conversation.ok);
    const projected = presentConversationAskPage(asks, { conversationId, after: 0, limit: 50 });
    assert('value' in projected);
    const directAsk = projected.value.items.find((ask) => ask.requestId === requestId);
    const combinedAsk = conversation.items.find(
      (item) => item.role === 'human' && item.ask?.requestId === requestId
    )?.ask;
    assert(directAsk && combinedAsk);
    const direct = directAsk.previewContext;
    const combined = combinedAsk.previewContext;
    assert.deepEqual(combined, direct);
    return direct;
  }
  assert.deepEqual(await readContext(), reference);
  const before = database()
    .getDatabase()
    .prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
    .get(requestId) as { sdk_message: string };
  const prompt = JSON.parse(before.sdk_message);
  assert.deepEqual(prompt.previewContext, reference);
  assert(JSON.stringify(prompt.message.content).includes(artifactId));
  assert(JSON.stringify(prompt.message.content).includes(previewContext.snapshot));
  let lostReceipt = true;
  let pendingAsks: readonly NeoPendingAsk[] = [];
  const intake = createNeoIntakeClient(
    async () =>
      ({
        request: async (...args: Parameters<MessageHub['request']>) => {
          const result = await hub.request<{ ok: boolean }>(...args);
          if (lostReceipt) {
            lostReceipt = false;
            assert.equal(result.ok, true);
            throw new Error('Synthetic lost intake receipt');
          }
          return result;
        },
      }) as unknown as MessageHub,
    (asks) => {
      pendingAsks = asks;
    }
  );
  const quote = {
    author: 'You' as const,
    text: input.content,
    anchor: 'synthetic-original-message',
    replyTo: { kind: 'message' as const, id: requestId },
  };
  const quotedSend = intake.send({
    sessionId,
    text: 'Reply to the original exact snapshot.',
    quote,
    previewContext: reference,
  });
  quote.replyTo.id = 'different-message';
  await assert.rejects(quotedSend, /Synthetic lost intake receipt/);
  const quotedId = pendingAsks[0].requestId;
  const encodedIntake = intake.snapshots.encode(pendingAsks);
  assert.equal(typeof encodedIntake, 'string');
  const decodedIntake = intake.snapshots.decode(encodedIntake);
  assert(!('kind' in decodedIntake));
  assert.equal(decodedIntake.entries[0].quote!.replyTo!.id, requestId);
  assert.deepEqual(decodedIntake.entries[0].previewContext, reference);
  const intakeScope = 'synthetic-intake-proof';
  const snapshotStorage = intake.snapshots.storage(intakeScope, () => captureStorage);
  const storedIntake = snapshotStorage.save(null, pendingAsks);
  assert(!('kind' in storedIntake));
  const loadedIntake = intake.snapshots.storage(intakeScope, () => captureStorage).read();
  assert(!('kind' in loadedIntake));
  assert.equal(loadedIntake.revision, storedIntake.revision);
  assert.deepEqual(loadedIntake.snapshot, decodedIntake);
  const staleIntake = snapshotStorage.save(null, []);
  assert('kind' in staleIntake && staleIntake.kind === 'snapshot_conflict');
  pendingAsks[0].quote!.replyTo!.id = 'changed-display-target';
  Object.assign(pendingAsks[0].previewContext!, { snapshot: 'b'.repeat(64) });
  const quotedRetry = await intake.retry(quotedId);
  assert(quotedRetry?.ok && !quotedRetry.created);
  const snapshotReplay = await submitNeoDraft(loadedIntake.snapshot.entries[0], async () => hub);
  assert(snapshotReplay.ok && !snapshotReplay.created);
  assert.deepEqual(snapshotReplay.previewContext, reference);
  const quotedRows = database()
    .getDatabase()
    .prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
    .all(quotedId) as { sdk_message: string }[];
  assert.equal(quotedRows.length, 1);
  const quotedPrompt = JSON.parse(quotedRows[0].sdk_message);
  assert.equal(quotedPrompt.replyTo.id, requestId);
  assert.deepEqual(quotedPrompt.previewContext, reference);
  const quotedJobs = database()
    .getDatabase()
    .prepare("SELECT COUNT(*) AS n FROM job_queue WHERE json_extract(payload,'$.messageUuid') = ?")
    .get(quotedId) as { n: number };
  assert.equal(quotedJobs.n, 1);
  const wrong = await rpc<{ ok: boolean }>('neo.message.send', {
    ...input,
    requestId: '20000000-0000-4000-8000-000000000002',
    previewContext: { ...previewContext, snapshot: '0'.repeat(64) },
  });
  assert.equal(wrong.ok, false);
  owners.recordRef('preview-todo', { adapter: 'hyperneo', id: 'worker', daemon: 'remote' });
  assert.deepEqual(await readContext(), { ...reference, state: 'unavailable' });
  assert.equal(
    (await rpc<{ accepted: boolean }>('artifact.file.read', { artifactId })).accepted,
    false
  );
  const retry = await rpc<typeof first>('neo.message.send', input);
  assert(retry.ok && !retry.created);
  assert.deepEqual(retry.previewContext, reference);
  const conflict = await rpc<{ ok: boolean }>('neo.message.send', {
    ...input,
    previewContext: undefined,
  });
  assert.equal(conflict.ok, false);
  const count = () => {
    const raw = database().getDatabase();
    const prompts = raw
      .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid = ?')
      .get(requestId) as { n: number };
    const jobs = raw
      .prepare(
        "SELECT COUNT(*) AS n FROM job_queue WHERE json_extract(payload,'$.messageUuid') = ?"
      )
      .get(requestId) as { n: number };
    assert.equal(prompts.n, 1);
    assert.equal(jobs.n, 1);
    const current = raw
      .prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
      .get(requestId) as { sdk_message: string };
    assert.equal(current.sdk_message, before.sdk_message);
  };
  count();
  await stop();
  await start();
  const reopenedIntake = createNeoIntakeClient(async () => hub)
    .snapshots.storage(intakeScope, () => captureStorage)
    .read();
  assert(!('kind' in reopenedIntake));
  const storedReplay = await submitNeoDraft(reopenedIntake.snapshot.entries[0], async () => hub);
  assert(storedReplay.ok && !storedReplay.created);
  const storedMessages = database()
    .getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid = ?')
    .get(quotedId) as { n: number };
  const storedJobs = database()
    .getDatabase()
    .prepare("SELECT COUNT(*) AS n FROM job_queue WHERE json_extract(payload,'$.messageUuid') = ?")
    .get(quotedId) as { n: number };
  assert.equal(storedMessages.n, 1);
  assert.equal(storedJobs.n, 1);
  assert.deepEqual(await readContext(), { ...reference, state: 'unavailable' });
  const replay = await submitNeoDraft(
    { sessionId, requestId, text: input.content, previewContext: reference },
    async () => hub
  );
  assert(replay.ok && !replay.created);
  assert.deepEqual(replay.previewContext, reference);
  await voiceProof.retry(hub);
  await voiceProof.refuse(hub);
  const voiceMessages = database()
    .getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid = ?')
    .get(voiceProof.id) as { n: number };
  const voiceJobs = database()
    .getDatabase()
    .prepare("SELECT COUNT(*) AS n FROM job_queue WHERE json_extract(payload,'$.messageUuid') = ?")
    .get(voiceProof.id) as { n: number };
  assert.equal(voiceMessages.n, 1);
  assert.equal(voiceJobs.n, 1);
  count();
  const legacy = await rpc<{ ok: boolean }>('neo.message.send', {
    sessionId,
    requestId: '20000000-0000-4000-8000-000000000003',
    content: 'An ordinary unbound ask.',
  });
  assert(legacy.ok && !('previewContext' in legacy));
  const noteFiles = await Promise.all(
    [0, 1].map((n) =>
      readNeoAttachment(
        new File(['x'.repeat(100_000)], `synthetic-notes-${n}.md`, { type: 'text/markdown' })
      )
    )
  );
  const notes = noteFiles.flatMap((file) => (typeof file === 'string' ? [] : [file]));
  assert.equal(notes.length, 2);
  const inlineText = attachmentMessage('Discuss the two attached notes.', notes);
  assert(inlineText.length > DRAFT_CHAR_LIMIT);
  let inlinePending: readonly NeoPendingAsk[] = [];
  const inlineIntake = createNeoIntakeClient(
    async () => hub,
    (asks) => {
      inlinePending = asks;
    }
  );
  const inlineReceipt = await inlineIntake.send({ sessionId, text: inlineText });
  assert(inlineReceipt.ok && inlineReceipt.created);
  const inlineReply = await inlineIntake.send({
    sessionId,
    text: 'Reply to both attached notes.',
    quote: {
      author: 'You',
      text: inlineText,
      anchor: 'synthetic-inline-notes',
      replyTo: { kind: 'message', id: inlineReceipt.requestId },
    },
  });
  assert(inlineReply.ok && inlineReply.created);
  const inlineSnapshot = inlineIntake.snapshots.decode(
    inlineIntake.snapshots.encode(inlinePending)
  );
  assert(!('kind' in inlineSnapshot));
  assert.equal(inlineSnapshot.entries.length, 2);
  assert.equal(inlineSnapshot.entries[0].text, inlineText);
  assert.equal(inlineSnapshot.entries[1].quote!.text, inlineText);
  for (const entry of inlineSnapshot.entries) {
    const replayed = await submitNeoDraft(entry, async () => hub);
    assert(replayed.ok && !replayed.created);
    const messages = database()
      .getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid = ?')
      .get(entry.requestId) as { n: number };
    const jobs = database()
      .getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n FROM job_queue WHERE json_extract(payload,'$.messageUuid') = ?"
      )
      .get(entry.requestId) as { n: number };
    assert.equal(messages.n, 1);
    assert.equal(jobs.n, 1);
  }
  Object.assign(evidence, {
    passed: true,
    exactSnapshot: true,
    serverDisplay: true,
    receiptAndMessageContext: true,
    sdkContextFact: true,
    bothReadProjections: true,
    revokedProjectionUnavailable: true,
    openingReauthorizes: true,
    retryNoDuplicate: true,
    restartPreserved: true,
    legacyCompatible: true,
    sourcePathsOmitted: true,
    webClientContext: true,
    webProjectionContext: true,
    voiceSnapshotPersisted: true,
    voiceRetryAfterRestart: true,
    voiceRefusalRetained: true,
    voiceMessageNoDuplicate: true,
    syntheticIndexedDb: true,
    sendHandoffConditionalClear: true,
    sendHandoffPreservesVoice: true,
    sendHandoffPreservesNewerDraft: true,
    reloadContextContract: true,
    reloadRecoveryProjection: true,
    reloadSizeRefusalPreserved: true,
    explicitUnboundRecovery: true,
    alreadySavedContextRestore: true,
    legacyRecoveryDedup: true,
    intakeQuoteSnapshotRetry: true,
    intakeDisplaySnapshotIsolation: true,
    intakeSnapshotContract: true,
    intakeSnapshotManualReplay: true,
    intakeSnapshotInlineTextAttachments: true,
    intakeSnapshotLongQuote: true,
    intakeSnapshotStorage: true,
    intakeSnapshotStorageRestartReplay: true,
  });
} finally {
  try {
    await voiceProof?.cleanup();
  } finally {
    await stop();
    evidence.ownedResourcesStopped = true;
    writeFileSync(join(run, 'evidence/preview-context.json'), JSON.stringify(evidence, null, 2));
  }
}
console.log(JSON.stringify(evidence));
