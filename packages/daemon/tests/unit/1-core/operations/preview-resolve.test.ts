import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactReferenceResolve } from '../../../../src/lib/artifacts/resolve-operation.ts';

describe('human stored reference capture', () => {
  test('resolves complete spaced inline-code paths from chat and todo sources', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-inline-spaces-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/preview-inline-spaces.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            HYPERNEO_DATA_DIR: join(root, 'data'),
            TMPDIR: root,
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        passed: true,
        chatSpaced: true,
        todoSpaced: true,
        safetyChecks: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('opens unregistered home-relative publication HTML through the existing capture checks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-home-reference-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/preview-home-reference.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: root, NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        passed: true,
        sameAbsoluteSnapshot: true,
        unregisteredHtmlContent: '<h1>Home-relative HTML content</h1>',
        sourceBound: true,
        ownershipRechecked: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('discovery and non-human calls do not touch SQLite or capture', async () => {
    const operation = createArtifactReferenceResolve(() => {
      throw new Error('SQLite touched');
    });
    expect(operation.name).toBe('artifact.reference.resolve');
    expect(
      await operation.execute(
        {
          sourceMessageOrCard: { kind: 'todo', id: 'todo' },
          reference: 'report.md',
          requestId: '11111111-1111-4111-8111-111111111111',
        },
        { source: 'mcp', role: 'neo', sessionId: 'neo' }
      )
    ).toEqual({ accepted: false, reason: 'unavailable' });
    const valid = {
      sourceMessageOrCard: { kind: 'todo', id: 'todo' },
      reference: 'report.md',
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    expect(operation.inputSchema.safeParse(valid).success).toBe(true);
    expect(operation.inputSchema.safeParse({ ...valid, root: '/outside' }).success).toBe(false);
    expect(
      operation.inputSchema.safeParse({
        ...valid,
        sourceMessageOrCard: { ...valid.sourceMessageOrCard, text: 'injected.md' },
      }).success
    ).toBe(false);
  });
  test('requires a caller-owned retry id before capture can allocate an immutable receipt', () => {
    const operation = createArtifactReferenceResolve(() => {
      throw new Error('SQLite touched');
    });
    const tap = { sourceMessageOrCard: { kind: 'todo', id: 'todo' }, reference: 'report.md' };
    expect(operation.inputSchema.safeParse(tap).success).toBe(false);
    expect(
      operation.inputSchema.safeParse({ ...tap, requestId: '11111111-1111-4111-8111-111111111111' })
        .success
    ).toBe(true);
  });
  test('captures only source-bound synthetic bytes and rechecks current authority', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-resolve-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../.claude/skills/verify/preview-resolve.ts', import.meta.url)
          ),
          root,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        exactSnapshot: true,
        sourceBound: true,
        ambiguity: true,
        revoked: true,
        safeDescriptor: true,
        historicalSource: true,
        restart: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
