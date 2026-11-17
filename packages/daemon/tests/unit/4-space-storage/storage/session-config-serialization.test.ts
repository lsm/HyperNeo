import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session, SessionConfig } from '@hyperneo/shared';
import { admitUpdateSessionConfig } from '../../../../src/lib/session/create-session-config';
import { codexSessionRefusal } from '../../../../src/lib/agent/session-engine';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import {
  SessionRepository,
  sessionConfigReplacer,
} from '../../../../src/storage/repositories/session-repository';

describe('sessionConfigReplacer', () => {
  test('drops the three excluded shapes wherever they appear in the tree', () => {
    const config = {
      model: 'm',
      zero: 0,
      empty: '',
      no: false,
      nothing: null,
      mcpServers: { fs: { command: 'x' } },
      workerOperations: [{ id: 1 }],
      nested: { keep: 'yes', workerOperations: [{ id: 2 }] },
      deeper: { level: { mcpServers: { a: 1 }, fn: () => 'dropped' } },
      fn: function named() {
        return 'dropped';
      },
    };
    expect(JSON.parse(JSON.stringify(config, sessionConfigReplacer))).toEqual({
      model: 'm',
      zero: 0,
      empty: '',
      no: false,
      nothing: null,
      nested: { keep: 'yes' },
      deeper: { level: {} },
    });
  });

  test('passes every other key through unchanged', () => {
    for (const value of ['s', 1, 0, true, false, null, { a: 1 }, [1, 2]]) {
      expect(sessionConfigReplacer('someKey', value)).toEqual(value);
    }
  });

  test('leaves keys that merely resemble the excluded ones alone', () => {
    expect(sessionConfigReplacer('mcpservers', { a: 1 })).toEqual({ a: 1 });
    expect(sessionConfigReplacer('workerOperationsCount', 3)).toBe(3);
  });
});

describe('session config serialization in SQLite', () => {
  let db: Database;
  let repository: SessionRepository;

  const session = (overrides: Partial<Session> = {}): Session => {
    const now = new Date().toISOString();
    return {
      id: 's1',
      title: 'Session',
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      config: { model: 'm', provider: 'anthropic', maxTokens: 4096, temperature: 0.7 },
      metadata: {},
      ...overrides,
    } as unknown as Session;
  };

  const storedConfig = () => {
    const row = db.prepare('SELECT config FROM sessions WHERE id = ?').get('s1') as {
      config: string;
    };
    return JSON.parse(row.config) as SessionConfig & Record<string, unknown>;
  };

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    repository = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('createSession persists config without the excluded shapes', () => {
    repository.createSession(
      session({
        config: {
          model: 'm',
          provider: 'anthropic',
          maxTokens: 4096,
          temperature: 0.7,
          mcpServers: { fs: { command: 'x' } },
          workerOperations: [{ id: 1 }],
        } as unknown as SessionConfig,
      })
    );
    expect(storedConfig()).toEqual({
      model: 'm',
      provider: 'anthropic',
      maxTokens: 4096,
      temperature: 0.7,
    });
  });

  test('a partial update merges and still excludes the same shapes', () => {
    repository.createSession(
      session({
        config: {
          model: 'm',
          provider: 'anthropic',
          maxTokens: 4096,
          temperature: 0.7,
          thinkingLevel: 'off',
        } as SessionConfig,
      })
    );
    repository.updateSession('s1', {
      config: {
        thinkingLevel: 'think16k',
        workerOperations: [{ id: 7 }],
      } as unknown as Partial<SessionConfig>,
    });
    expect(storedConfig()).toEqual({
      model: 'm',
      provider: 'anthropic',
      maxTokens: 4096,
      temperature: 0.7,
      thinkingLevel: 'think16k',
    });
  });

  test('explicitly clears legacy OXAP restrictions while preserving tool selection', () => {
    const toolSelection = { version: 1, choices: {} } as const;
    repository.createSession(
      session({
        config: {
          model: 'gpt-5.5',
          provider: 'anthropic-codex',
          harness: 'oxap-codex',
          maxTokens: 4096,
          temperature: 0,
          toolSelection,
          tools: { disabledTools: ['Bash'] },
          allowedTools: ['Read'],
          disallowedTools: ['Write'],
          sdkToolsPreset: ['Read'],
          maxTurns: 2,
          maxBudgetUsd: 1,
          additionalDirectories: ['/other'],
        } as unknown as SessionConfig,
      })
    );
    const clear = {
      tools: null,
      allowedTools: null,
      disallowedTools: null,
      sdkToolsPreset: null,
      maxTurns: null,
      maxBudgetUsd: null,
      additionalDirectories: null,
    } as unknown as Partial<SessionConfig>;
    const before = storedConfig();
    expect(codexSessionRefusal(before, false, false)).toBeDefined();
    const admitted = admitUpdateSessionConfig(clear, undefined, before);
    repository.updateSession('s1', { config: admitted });
    const after = storedConfig();
    expect(after.toolSelection).toEqual(toolSelection);
    for (const field of Object.keys(clear)) expect(after).not.toHaveProperty(field);
    expect(codexSessionRefusal(after, false, false)).toBeUndefined();
  });

  test('updateSession keeps its failed-to-serialize wrapper text', () => {
    repository.createSession(session());
    expect(() =>
      repository.updateSession('s1', { config: { bad: 1n } as unknown as Partial<SessionConfig> })
    ).toThrow('updateSession: failed to serialize config for session "s1"');
  });

  test('createSession raises the native serialization exception, unwrapped', () => {
    expect(() =>
      repository.createSession(session({ config: { bad: 1n } as unknown as SessionConfig }))
    ).toThrow(TypeError);
  });
});
