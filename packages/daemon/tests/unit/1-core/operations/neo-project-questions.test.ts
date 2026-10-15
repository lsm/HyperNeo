import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { neoAskAnswerEvidence } from '../../../../src/lib/neo/ask-answer-evidence.ts';
import { neoReorganizeRuntime } from '../../../../src/lib/neo/operations.ts';
import {
  NEO_PROJECT_SAME,
  NEO_PROJECT_SEPARATE,
  planNeoProjectQuestions,
  readNeoProjectDecision,
} from '../../../../src/lib/neo/project-merge.ts';
import type { NeoRouter } from '../../../../src/lib/neo/router.ts';
import type { NeoService } from '../../../../src/lib/neo/service.ts';
import { NeoAskRepository } from '../../../../src/storage/repositories/neo-ask-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const identity = `git:${'a'.repeat(40)}`;
const repository = 'repo:lsm/web';
const project = (id: string, extra: Partial<NeoProject> = {}): NeoProject => ({
  id,
  title: id,
  summary: id,
  context: '',
  revision: 1,
  parentId: null,
  epicUrl: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe('planNeoProjectQuestions', () => {
  test('asks about siblings sharing a repository when identity cannot settle it, once per project', () => {
    const questions = planNeoProjectQuestions(
      {
        projects: [
          project('web', { createdAt: 1 }),
          project('web-shallow', { createdAt: 2 }),
          project('web-other', { createdAt: 3 }),
          project('web-known', { createdAt: 4 }),
          project('web-nested', { createdAt: 5, parentId: 'travel' }),
          project('notes', { createdAt: 6 }),
        ],
        identities: { web: [identity], 'web-known': [`git:${'b'.repeat(40)}`] },
        unavailable: [],
        retired: [],
      },
      {},
      {
        web: [repository],
        'web-shallow': [repository],
        'web-other': [repository],
        'web-known': [repository],
        'web-nested': [repository],
        notes: ['repo:lsm/notes'],
      }
    );
    expect(questions.map(({ sourceId, targetId }) => [sourceId, targetId])).toEqual([
      ['web-shallow', 'web'],
      ['web-other', 'web'],
    ]);
    expect(questions[0]).toMatchObject({
      key: 'neo-project-merge:web\u0000web-shallow',
      repository,
      sourceRevision: 1,
      targetRevision: 1,
    });
  });
});

describe('readNeoProjectDecision', () => {
  const ask = (
    state: 'pending' | 'met',
    evidence: string | null,
    status: NeoAsk['status'] = 'waiting'
  ) =>
    ({
      status,
      doneItems: [
        {
          id: 'i1',
          text: 'q',
          state,
          evidence,
          check: null,
          metBy: null,
          removed: false,
          addedAt: 1,
          decides: 'k',
        },
      ],
    }) as Pick<NeoAsk, 'doneItems' | 'status'>;

  test('reads an answer Neo recorded from a chat message the same as a button answer', () => {
    expect(
      readNeoProjectDecision(
        [ask('met', neoAskAnswerEvidence(NEO_PROJECT_SAME, 'reply-1'), 'achieved')],
        'k'
      )
    ).toEqual({ decision: 'same' });
    expect(
      readNeoProjectDecision(
        [ask('met', neoAskAnswerEvidence(NEO_PROJECT_SEPARATE, 'reply-2'), 'achieved')],
        'k'
      )
    ).toEqual({ decision: 'separate' });
  });

  test('reads only an exact button answer as a decision', () => {
    expect(readNeoProjectDecision([], 'k')).toEqual({ ask: 1 });
    expect(readNeoProjectDecision([ask('pending', null)], 'k')).toEqual({
      decision: 'pending',
    });
    expect(
      readNeoProjectDecision([ask('met', `The human answered: ${NEO_PROJECT_SAME}`)], 'k')
    ).toEqual({ decision: 'same' });
    expect(
      readNeoProjectDecision([ask('met', `The human answered: ${NEO_PROJECT_SEPARATE}`)], 'k')
    ).toEqual({ decision: 'separate' });
  });

  test('asks again after a dropped or unclear question, at most three times', () => {
    const dropped = ask('pending', null, 'abandoned');
    const unclear = ask('met', 'The human answered: maybe, ask me later');
    expect(readNeoProjectDecision([dropped], 'k')).toEqual({ ask: 2 });
    expect(readNeoProjectDecision([dropped, unclear], 'k')).toEqual({ ask: 3 });
    expect(readNeoProjectDecision([dropped, unclear, dropped], 'k')).toEqual({
      decision: 'separate',
    });
    expect(readNeoProjectDecision([ask('pending', null)], 'other')).toEqual({ ask: 2 });
  });
});

describe('reorganize merge questions on a real store', () => {
  let directory: string;
  let db: Database;
  let repo: NeoRepository;
  let asks: NeoAskRepository;
  let logged: string[];
  const root = 'neo:10000000-0000-4000-8000-000000000001';
  const key = 'neo-project-merge:web\u0000web-shallow';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-project-questions-'));
    db = new Database(join(directory, 'fictional.db'));
    createTables(db);
    runMigrations(db, () => {});
    repo = new NeoRepository(db);
    asks = new NeoAskRepository(db);
    logged = [];
    repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    for (const id of ['web', 'web-shallow'])
      repo.saveProject({ id, title: id, summary: id, context: id }, 0);
    db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(identity, 'web');
    for (const [alias, id] of [
      [`${repository}\u0000laptop`, 'web'],
      [`${repository}\u0000desktop`, 'web-shallow'],
    ])
      db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run(alias, id);
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const runtime = () =>
    neoReorganizeRuntime(
      {
        repo,
        askRecords: asks,
        logReorganize: (line: string) => logged.push(line),
      } as unknown as NeoService,
      (async () => ({ choice: null })) as unknown as NeoRouter
    );
  const answer = (choice: string) => {
    const ask = asks.forRequest(key)!;
    const item = ask.doneItems!.find((entry) => entry.decides === key)!;
    asks.tickItem(
      ask.id,
      { id: item.id, state: 'met', evidence: `The human answered: ${choice}`, metBy: 'human' },
      Date.now(),
      item,
      true
    );
  };

  test('asks the human once and keeps the question pending across runs', async () => {
    expect(await runtime().mergeProjects()).toEqual({
      merged: [],
      asked: [{ sourceId: 'web-shallow', targetId: 'web' }],
    });
    const ask = asks.forRequest(key)!;
    expect(ask).toMatchObject({ originSessionId: root, projectId: null, status: 'waiting' });
    expect(ask.doneItems?.find((item) => item.decides === key)).toMatchObject({
      question: 'Are web-shallow and web the same project? Both point at lsm/web.',
      options: [NEO_PROJECT_SAME, NEO_PROJECT_SEPARATE],
      state: 'needs_you',
    });
    expect(await runtime().mergeProjects()).toEqual({ merged: [], asked: [] });
  });

  test('an answer of the same project merges as human approved, and is never asked again', async () => {
    await runtime().mergeProjects();
    answer(NEO_PROJECT_SAME);
    expect(await runtime().mergeProjects()).toEqual({
      merged: [{ sourceId: 'web-shallow', targetId: 'web' }],
      asked: [],
    });
    expect(repo.listProjects().map((item) => item.id)).toEqual(['web']);
    expect(await runtime().mergeProjects()).toEqual({ merged: [], asked: [] });
  });

  test('a dropped question is asked again under a new key', async () => {
    await runtime().mergeProjects();
    const first = asks.forRequest(key)!;
    asks.settle(first, 'abandoned', 'Closed by the user.', 'Closed by the user.');
    expect(await runtime().mergeProjects()).toEqual({
      merged: [],
      asked: [{ sourceId: 'web-shallow', targetId: 'web' }],
    });
    expect(asks.forRequest(`${key}#2`)?.status).toBe('waiting');
  });

  test('an answer to keep them separate is saved and never asked again', async () => {
    await runtime().mergeProjects();
    answer(NEO_PROJECT_SEPARATE);
    expect(await runtime().mergeProjects()).toEqual({ merged: [], asked: [] });
    expect(
      repo
        .listProjects()
        .map((item) => item.id)
        .sort()
    ).toEqual(['web', 'web-shallow']);
    expect(logged).toEqual([]);
  });
});
