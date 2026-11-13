import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('NeoAskTodoRepository while the writer lane holds a write', () => {
  let dir: string;
  let path: string;
  let db: Database;
  let store: NeoAskTodoRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neo-writes-beside-writer-'));
    path = join(dir, 'daemon.db');
    db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Synthetic work',
      request: 'Synthetic request',
      createdAt: 1,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const whileWriterHolds = async <T>(write: () => T) => {
    const holder = spawn(
      'node',
      [fileURLToPath(new URL('./sqlite-write-holder-fixture.mjs', import.meta.url)), path, '300'],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    const outcome: { value?: T; error?: string } = {};
    const exited = new Promise<number | null>((resolve) => holder.on('exit', resolve));
    let seen = '';
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.stdout.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes('held')) resolve();
      });
    });
    try {
      outcome.value = write();
    } catch (error) {
      outcome.error = String(error);
    }
    expect(await exited).toBe(0);
    return outcome;
  };

  test('opens a question card after the writer commits instead of failing as locked', async () => {
    const outcome = await whileWriterHolds(() =>
      store.writeCardReply(null, 'card', () =>
        store.askQuestion(
          'card',
          'ask',
          {
            text: 'Which way?',
            kind: 'choice',
            options: ['Server', 'Both'],
            multiple: false,
            noLabel: null,
            yesLabel: null,
            startTodos: null,
          },
          20
        )
      )
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.id).toBe('card');
    expect(store.getQuestion('card')?.state).toBe('open');
  });

  test('commits a read-then-write transaction after the writer commits', async () => {
    const outcome = await whileWriterHolds(() =>
      store.inTransaction(() => {
        const ask = store.getAsk('ask');
        store.retireQuestions('ask', 30);
        return ask?.id;
      })
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe('ask');
  });
});
