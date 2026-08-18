import { describe, expect, it, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReferenceResolver } from '../../../src/lib/agent/reference-resolver';
import type {
  ResolutionContext,
  TaskRepoLike,
  GoalRepoLike,
  SpaceTaskRepoLike,
} from '../../../src/lib/agent/reference-resolver';
import type { ResolvedFileReference, ResolvedFolderReference } from '@hyperneo/shared';

async function createWorkspace(): Promise<string> {
  const dir = join(
    tmpdir(),
    `ref-resolver-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function assertFileResult(
  result: Awaited<ReturnType<ReferenceResolver['resolveReference']>>
): asserts result is ResolvedFileReference {
  if (result?.type !== 'file') {
    throw new Error(`Expected file result, got: ${result?.type ?? 'null'}`);
  }
}

function assertFolderResult(
  result: Awaited<ReturnType<ReferenceResolver['resolveReference']>>
): asserts result is ResolvedFolderReference {
  if (result?.type !== 'folder') {
    throw new Error(`Expected folder result, got: ${result?.type ?? 'null'}`);
  }
}

describe('ReferenceResolver', () => {
  let workspace: string;
  let resolver: ReferenceResolver;
  let ctx: ResolutionContext;

  beforeEach(async () => {
    workspace = await createWorkspace();
    resolver = new ReferenceResolver();
    ctx = { workspacePath: workspace };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('extractReferences', () => {
    it('parses a file reference', () => {
      const mentions = resolver.extractReferences('Look at @ref{file:src/utils.ts}');
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        type: 'file',
        id: 'src/utils.ts',
        displayText: '@ref{file:src/utils.ts}',
      });
    });

    it('parses a folder reference', () => {
      const mentions = resolver.extractReferences('Browse @ref{folder:src/components}');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].type).toBe('folder');
      expect(mentions[0].id).toBe('src/components');
    });

    it('parses a task reference', () => {
      const mentions = resolver.extractReferences('Fix @ref{task:t-42}');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].type).toBe('task');
      expect(mentions[0].id).toBe('t-42');
    });

    it('parses a goal reference', () => {
      const mentions = resolver.extractReferences('Goal: @ref{goal:g-7}');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].type).toBe('goal');
    });

    it('parses multiple references in one string', () => {
      const text = '@ref{file:a.ts} and @ref{folder:src} and @ref{task:t-1}';
      const mentions = resolver.extractReferences(text);
      expect(mentions).toHaveLength(3);
    });

    it('deduplicates identical mentions', () => {
      const text = '@ref{file:a.ts} @ref{file:a.ts} @ref{file:a.ts}';
      const mentions = resolver.extractReferences(text);
      expect(mentions).toHaveLength(1);
    });

    it('returns empty array for text with no references', () => {
      expect(resolver.extractReferences('Hello world')).toHaveLength(0);
      expect(resolver.extractReferences('')).toHaveLength(0);
    });

    it('ignores unknown reference types', () => {
      const mentions = resolver.extractReferences('@ref{unknown:foo}');
      expect(mentions).toHaveLength(0);
    });

    it('does not match partial or malformed patterns', () => {
      expect(resolver.extractReferences('@ref{file}')).toHaveLength(0);
      expect(resolver.extractReferences('@ref{:id}')).toHaveLength(0);
      expect(resolver.extractReferences('ref{file:a.ts}')).toHaveLength(0);
    });

    it('preserves displayText as the full @ref{} string', () => {
      const [m] = resolver.extractReferences('@ref{file:path/to/file.ts}');
      expect(m.displayText).toBe('@ref{file:path/to/file.ts}');
    });
  });

  describe('resolveReference — file', () => {
    it('resolves a text file to its content and metadata', async () => {
      await writeFile(join(workspace, 'hello.txt'), 'Hello World');

      const result = await resolver.resolveReference(
        { type: 'file', id: 'hello.txt', displayText: '@ref{file:hello.txt}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.content).toBe('Hello World');
      expect(result.data.binary).toBe(false);
      expect(result.data.size).toBe(11);
      expect(result.data.path).toBe('hello.txt');
      expect(result.data.mtime).toBeDefined();
    });

    it('resolves a nested file path', async () => {
      await mkdir(join(workspace, 'src', 'lib'), { recursive: true });
      await writeFile(join(workspace, 'src', 'lib', 'utils.ts'), 'export const x = 1;');

      const result = await resolver.resolveReference(
        { type: 'file', id: 'src/lib/utils.ts', displayText: '@ref{file:src/lib/utils.ts}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.content).toBe('export const x = 1;');
    });

    it('returns null for a non-existent file', async () => {
      const result = await resolver.resolveReference(
        { type: 'file', id: 'missing.txt', displayText: '@ref{file:missing.txt}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('returns null when referencing a directory as a file', async () => {
      await mkdir(join(workspace, 'src'), { recursive: true });

      const result = await resolver.resolveReference(
        { type: 'file', id: 'src', displayText: '@ref{file:src}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('marks text files as non-binary', async () => {
      await writeFile(join(workspace, 'text.ts'), 'const a = 1;');

      const result = await resolver.resolveReference(
        { type: 'file', id: 'text.ts', displayText: '@ref{file:text.ts}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.binary).toBe(false);
    });

    it('marks binary files with binary:true and null content', async () => {
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
      await writeFile(join(workspace, 'image.png'), binaryContent);

      const result = await resolver.resolveReference(
        { type: 'file', id: 'image.png', displayText: '@ref{file:image.png}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.binary).toBe(true);
      expect(result.data.content).toBeNull();
    });

    it('truncates large text files at a line boundary', async () => {
      const lineContent = 'x'.repeat(99) + '\n';
      const totalLines = 600;
      await writeFile(join(workspace, 'big.txt'), lineContent.repeat(totalLines));

      const result = await resolver.resolveReference(
        { type: 'file', id: 'big.txt', displayText: '@ref{file:big.txt}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.size).toBeGreaterThan(50 * 1024);
      expect(result.data.truncated).toBe(true);
      expect(result.data.content).not.toBeNull();
      expect(Buffer.byteLength(result.data.content as string, 'utf-8')).toBeLessThanOrEqual(
        50 * 1024
      );
      if ((result.data.content as string).length > 0) {
        expect((result.data.content as string).endsWith('\n')).toBe(true);
      }
    });

    it('returns full content for files exactly at the 50KB limit', async () => {
      const content = 'a'.repeat(50 * 1024);
      await writeFile(join(workspace, 'exact.txt'), content);

      const result = await resolver.resolveReference(
        { type: 'file', id: 'exact.txt', displayText: '@ref{file:exact.txt}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.content).toBe(content);
      expect(result.data.truncated).toBe(false);
    });

    it('handles empty files', async () => {
      await writeFile(join(workspace, 'empty.txt'), '');

      const result = await resolver.resolveReference(
        { type: 'file', id: 'empty.txt', displayText: '@ref{file:empty.txt}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.content).toBe('');
      expect(result.data.size).toBe(0);
    });

    it('handles unicode content correctly', async () => {
      const text = '// 你好世界\nconst x = "🌍";\n';
      await writeFile(join(workspace, 'unicode.ts'), text);

      const result = await resolver.resolveReference(
        { type: 'file', id: 'unicode.ts', displayText: '@ref{file:unicode.ts}' },
        ctx
      );

      assertFileResult(result);
      expect(result.data.content).toBe(text);
    });

    it('works without room or space context', async () => {
      await writeFile(join(workspace, 'standalone.txt'), 'content');

      const result = await resolver.resolveReference(
        { type: 'file', id: 'standalone.txt', displayText: '@ref{file:standalone.txt}' },
        { workspacePath: workspace }
      );

      expect(result).not.toBeNull();
    });
  });

  describe('resolveReference — folder', () => {
    it('resolves a folder to its file listing', async () => {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src', 'a.ts'), 'a');
      await writeFile(join(workspace, 'src', 'b.ts'), 'b');

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'src', displayText: '@ref{folder:src}' },
        ctx
      );

      assertFolderResult(result);
      expect(result.data.path).toBe('src');
      expect(result.data.entries).toHaveLength(2);
    });

    it('returns null for a non-existent folder', async () => {
      const result = await resolver.resolveReference(
        { type: 'folder', id: 'missing', displayText: '@ref{folder:missing}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('returns null when referencing a file as a folder', async () => {
      await writeFile(join(workspace, 'file.txt'), 'content');

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'file.txt', displayText: '@ref{folder:file.txt}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('limits large directories to 200 entries', async () => {
      await mkdir(join(workspace, 'big'), { recursive: true });
      for (let i = 0; i < 250; i++) {
        await writeFile(join(workspace, 'big', `file${i}.txt`), String(i));
      }

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'big', displayText: '@ref{folder:big}' },
        ctx
      );

      assertFolderResult(result);
      expect(result.data.entries).toHaveLength(200);
    });

    it('returns all entries for directories with fewer than 200 files', async () => {
      await mkdir(join(workspace, 'small'), { recursive: true });
      for (let i = 0; i < 5; i++) {
        await writeFile(join(workspace, 'small', `f${i}.txt`), String(i));
      }

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'small', displayText: '@ref{folder:small}' },
        ctx
      );

      assertFolderResult(result);
      expect(result.data.entries).toHaveLength(5);
    });

    it('handles empty directories', async () => {
      await mkdir(join(workspace, 'empty'), { recursive: true });

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'empty', displayText: '@ref{folder:empty}' },
        ctx
      );

      assertFolderResult(result);
      expect(result.data.entries).toHaveLength(0);
    });

    it('works without room or space context', async () => {
      await mkdir(join(workspace, 'lib'), { recursive: true });
      await writeFile(join(workspace, 'lib', 'index.ts'), 'export {}');

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'lib', displayText: '@ref{folder:lib}' },
        { workspacePath: workspace }
      );

      expect(result).not.toBeNull();
    });
  });

  describe('path traversal prevention', () => {
    it('rejects empty file path', async () => {
      const result = await resolver.resolveReference(
        { type: 'file', id: '', displayText: '@ref{file:}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects empty folder path', async () => {
      const result = await resolver.resolveReference(
        { type: 'folder', id: '', displayText: '@ref{folder:}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects file path with .. segment', async () => {
      const result = await resolver.resolveReference(
        { type: 'file', id: '../secret.txt', displayText: '@ref{file:../secret.txt}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects file path with embedded ..', async () => {
      const result = await resolver.resolveReference(
        {
          type: 'file',
          id: 'src/../../../etc/passwd',
          displayText: '@ref{file:src/../../../etc/passwd}',
        },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects absolute file path', async () => {
      const result = await resolver.resolveReference(
        { type: 'file', id: '/etc/passwd', displayText: '@ref{file:/etc/passwd}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects folder path with ..', async () => {
      const result = await resolver.resolveReference(
        { type: 'folder', id: '../outside', displayText: '@ref{folder:../outside}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects absolute folder path', async () => {
      const result = await resolver.resolveReference(
        { type: 'folder', id: '/tmp', displayText: '@ref{folder:/tmp}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects a symlink pointing outside the workspace', async () => {
      const linkPath = join(workspace, 'evil-link');
      await symlink(tmpdir(), linkPath);

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'evil-link', displayText: '@ref{folder:evil-link}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('rejects a file symlink pointing outside the workspace', async () => {
      const linkPath = join(workspace, 'evil-file');
      try {
        await symlink('/etc/hosts', linkPath);
      } catch {
        return;
      }

      const result = await resolver.resolveReference(
        { type: 'file', id: 'evil-file', displayText: '@ref{file:evil-file}' },
        ctx
      );
      expect(result).toBeNull();
    });

    it('allows legitimate paths within the workspace', async () => {
      await mkdir(join(workspace, 'src', 'lib'), { recursive: true });
      await writeFile(join(workspace, 'src', 'lib', 'utils.ts'), 'ok');

      const result = await resolver.resolveReference(
        { type: 'file', id: 'src/lib/utils.ts', displayText: '@ref{file:src/lib/utils.ts}' },
        ctx
      );
      expect(result).not.toBeNull();
    });

    it('allows symlinks that point within the workspace', async () => {
      await mkdir(join(workspace, 'real'), { recursive: true });
      await writeFile(join(workspace, 'real', 'file.txt'), 'hello');
      await symlink(join(workspace, 'real'), join(workspace, 'link-within'));

      const result = await resolver.resolveReference(
        { type: 'folder', id: 'link-within', displayText: '@ref{folder:link-within}' },
        ctx
      );
      expect(result).not.toBeNull();
    });
  });

  describe('task and goal references without injected repos', () => {
    it('returns null for task references when no repo injected', async () => {
      const result = await resolver.resolveReference(
        { type: 'task', id: 't-42', displayText: '@ref{task:t-42}' },
        { ...ctx, roomId: 'room-1' }
      );
      expect(result).toBeNull();
    });

    it('returns null for goal references when no repo injected', async () => {
      const result = await resolver.resolveReference(
        { type: 'goal', id: 'g-7', displayText: '@ref{goal:g-7}' },
        { ...ctx, roomId: 'room-1' }
      );
      expect(result).toBeNull();
    });
  });

  describe('resolveAllReferences', () => {
    it('resolves all valid references in a text', async () => {
      await writeFile(join(workspace, 'a.ts'), 'const a = 1;');
      await mkdir(join(workspace, 'lib'), { recursive: true });
      await writeFile(join(workspace, 'lib', 'b.ts'), 'export {};');

      const text = 'Check @ref{file:a.ts} and @ref{folder:lib}';
      const result = await resolver.resolveAllReferences(text, ctx);

      expect(Object.keys(result)).toHaveLength(2);
      expect(result['@ref{file:a.ts}'].type).toBe('file');
      expect(result['@ref{folder:lib}'].type).toBe('folder');
    });

    it('returns empty object for text with no references', async () => {
      const result = await resolver.resolveAllReferences('plain text', ctx);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('skips unresolvable references without throwing', async () => {
      const result = await resolver.resolveAllReferences(
        '@ref{file:missing.txt} and @ref{file:../escape}',
        ctx
      );
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('returns partial results when some references fail', async () => {
      await writeFile(join(workspace, 'good.txt'), 'ok');

      const text = '@ref{file:good.txt} @ref{file:bad.txt}';
      const result = await resolver.resolveAllReferences(text, ctx);

      expect(result['@ref{file:good.txt}']).toBeDefined();
      expect(result['@ref{file:bad.txt}']).toBeUndefined();
    });
  });
});

const ROOM_ID = 'room-abc';
const OTHER_ROOM_ID = 'room-xyz';
const SPACE_ID = 'space-111';
const OTHER_SPACE_ID = 'space-222';
const WORKSPACE = '/workspace';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-uuid-1',
    shortId: 't-1',
    roomId: ROOM_ID,
    title: 'Default Task',
    description: '',
    status: 'pending',
    priority: 'normal',
    dependsOn: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeSpaceTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'space-task-uuid-1',
    spaceId: SPACE_ID,
    title: 'Default Space Task',
    description: '',
    status: 'pending',
    priority: 'normal',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-uuid-1',
    shortId: 'g-1',
    roomId: ROOM_ID,
    title: 'Default Goal',
    description: '',
    status: 'active',
    priority: 'normal',
    progress: 0,
    linkedTaskIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function mockTaskRepo(returnValue?: ReturnType<typeof makeTask>): TaskRepoLike {
  return { getTaskByShortId: mock(() => returnValue ?? null) };
}

function mockGoalRepo(returnValue?: ReturnType<typeof makeGoal>): GoalRepoLike {
  return { getGoalByShortId: mock(() => returnValue ?? null) };
}

function mockSpaceTaskRepo(returnValue?: ReturnType<typeof makeSpaceTask>): SpaceTaskRepoLike {
  return { getTask: mock(() => returnValue ?? null) };
}

describe('ReferenceResolver — room task resolution', () => {
  test('resolves a room task by shortId', async () => {
    const task = makeTask({ shortId: 't-1', title: 'Implement auth', priority: 'high' });
    const resolver = new ReferenceResolver({ taskRepo: mockTaskRepo(task) });

    const result = await resolver.resolveReference(
      { type: 'task', id: 't-1', displayText: '@ref{task:t-1}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('task');
    expect(result!.id).toBe(task.id);
    const data = result!.data as typeof task;
    expect(data.shortId).toBe('t-1');
    expect(data.title).toBe('Implement auth');
    expect(data.roomId).toBe(ROOM_ID);
  });

  test('returns null when session has no room context', async () => {
    const resolver = new ReferenceResolver({ taskRepo: mockTaskRepo(makeTask()) });

    const result = await resolver.resolveReference(
      { type: 'task', id: 't-1', displayText: '@ref{task:t-1}' },
      { workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('returns null for unrecognized task ID format (no t- or st- prefix)', async () => {
    const resolver = new ReferenceResolver({ taskRepo: mockTaskRepo(makeTask()) });

    const result = await resolver.resolveReference(
      { type: 'task', id: 'abc123', displayText: '@ref{task:abc123}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('returns null when task does not exist', async () => {
    const resolver = new ReferenceResolver({ taskRepo: mockTaskRepo() });

    const result = await resolver.resolveReference(
      { type: 'task', id: 't-999', displayText: '@ref{task:t-999}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('cross-room check: rejects task whose roomId differs from context', async () => {
    const task = makeTask({ roomId: OTHER_ROOM_ID });
    const resolver = new ReferenceResolver({ taskRepo: mockTaskRepo(task) });

    const result = await resolver.resolveReference(
      { type: 'task', id: 't-1', displayText: '@ref{task:t-1}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });
});

describe('ReferenceResolver — space task resolution', () => {
  test('resolves a space task by st-<uuid> reference', async () => {
    const task = makeSpaceTask({ id: 'uuid-aaa', title: 'Deploy service' });
    const resolver = new ReferenceResolver({ spaceTaskRepo: mockSpaceTaskRepo(task) });

    const result = await resolver.resolveReference(
      { type: 'task', id: `st-${task.id}`, displayText: `@ref{task:st-${task.id}}` },
      { spaceId: SPACE_ID, workspacePath: WORKSPACE }
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('task');
    expect(result!.id).toBe(task.id);
    expect((result!.data as typeof task).title).toBe('Deploy service');
  });

  test('returns null when session has no space context', async () => {
    const task = makeSpaceTask();
    const resolver = new ReferenceResolver({ spaceTaskRepo: mockSpaceTaskRepo(task) });

    const result = await resolver.resolveReference(
      { type: 'task', id: `st-${task.id}`, displayText: `@ref{task:st-${task.id}}` },
      { workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('returns null when space task UUID does not exist', async () => {
    const resolver = new ReferenceResolver({ spaceTaskRepo: mockSpaceTaskRepo() });

    const result = await resolver.resolveReference(
      { type: 'task', id: 'st-nonexistent-uuid', displayText: '@ref{task:st-nonexistent-uuid}' },
      { spaceId: SPACE_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('returns null for cross-space reference', async () => {
    const task = makeSpaceTask({ spaceId: OTHER_SPACE_ID });
    const resolver = new ReferenceResolver({ spaceTaskRepo: mockSpaceTaskRepo(task) });

    const result = await resolver.resolveReference(
      { type: 'task', id: `st-${task.id}`, displayText: `@ref{task:st-${task.id}}` },
      { spaceId: SPACE_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('returns null gracefully for st-<non-uuid> value', async () => {
    const resolver = new ReferenceResolver({ spaceTaskRepo: mockSpaceTaskRepo() });

    const result = await resolver.resolveReference(
      { type: 'task', id: 'st-not-a-uuid', displayText: '@ref{task:st-not-a-uuid}' },
      { spaceId: SPACE_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });
});

describe('ReferenceResolver — goal resolution', () => {
  test('resolves a goal by shortId', async () => {
    const goal = makeGoal({ shortId: 'g-1', title: 'Q1 Revenue Target', progress: 75 });
    const resolver = new ReferenceResolver({ goalRepo: mockGoalRepo(goal) });

    const result = await resolver.resolveReference(
      { type: 'goal', id: 'g-1', displayText: '@ref{goal:g-1}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('goal');
    expect(result!.id).toBe(goal.id);
    const data = result!.data as typeof goal;
    expect(data.shortId).toBe('g-1');
    expect(data.title).toBe('Q1 Revenue Target');
    expect(data.progress).toBe(75);
  });

  test('returns null when session has no room context', async () => {
    const resolver = new ReferenceResolver({ goalRepo: mockGoalRepo(makeGoal()) });

    const result = await resolver.resolveReference(
      { type: 'goal', id: 'g-1', displayText: '@ref{goal:g-1}' },
      { workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('returns null when goal does not exist', async () => {
    const resolver = new ReferenceResolver({ goalRepo: mockGoalRepo() });

    const result = await resolver.resolveReference(
      { type: 'goal', id: 'g-999', displayText: '@ref{goal:g-999}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });

  test('resolves goal with missionType and autonomyLevel fields', async () => {
    const goal = makeGoal({ missionType: 'measurable', autonomyLevel: 'semi_autonomous' });
    const resolver = new ReferenceResolver({ goalRepo: mockGoalRepo(goal) });

    const result = await resolver.resolveReference(
      { type: 'goal', id: 'g-1', displayText: '@ref{goal:g-1}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    const data = result!.data as typeof goal;
    expect(data.missionType).toBe('measurable');
    expect(data.autonomyLevel).toBe('semi_autonomous');
  });

  test('cross-room check: rejects goal whose roomId differs from context', async () => {
    const goal = makeGoal({ roomId: OTHER_ROOM_ID });
    const resolver = new ReferenceResolver({ goalRepo: mockGoalRepo(goal) });

    const result = await resolver.resolveReference(
      { type: 'goal', id: 'g-1', displayText: '@ref{goal:g-1}' },
      { roomId: ROOM_ID, workspacePath: WORKSPACE }
    );

    expect(result).toBeNull();
  });
});

describe('ReferenceResolver.resolveAllReferences — task/goal', () => {
  test('resolves task and goal references together', async () => {
    const task = makeTask({ shortId: 't-1' });
    const goal = makeGoal({ shortId: 'g-1' });
    const resolver = new ReferenceResolver({
      taskRepo: mockTaskRepo(task),
      goalRepo: mockGoalRepo(goal),
    });

    const text = 'Work on @ref{task:t-1} toward @ref{goal:g-1}';
    const result = await resolver.resolveAllReferences(text, {
      roomId: ROOM_ID,
      workspacePath: WORKSPACE,
    });

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['@ref{task:t-1}']).toBeDefined();
    expect(result['@ref{goal:g-1}']).toBeDefined();
  });

  test('omits unresolvable task references', async () => {
    const task = makeTask({ shortId: 't-1' });
    const tRepo: TaskRepoLike = {
      getTaskByShortId: mock((_, shortId: string) => (shortId === 't-1' ? task : null)),
    };
    const resolver = new ReferenceResolver({ taskRepo: tRepo });

    const result = await resolver.resolveAllReferences('@ref{task:t-1} @ref{task:t-999}', {
      roomId: ROOM_ID,
      workspacePath: WORKSPACE,
    });

    expect(Object.keys(result)).toHaveLength(1);
    expect(result['@ref{task:t-1}']).toBeDefined();
  });
});
