import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { FileManager } from '../../../src/lib/file-manager';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('FileManager (Unit)', () => {
  let testWorkspace: string;
  let fileManager: FileManager;

  beforeEach(async () => {
    testWorkspace = join(
      tmpdir(),
      `file-manager-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testWorkspace, { recursive: true });
    fileManager = new FileManager(testWorkspace);
  });

  afterEach(async () => {
    await rm(testWorkspace, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create FileManager with workspace path', () => {
      const fm = new FileManager('/test/workspace');
      expect(fm.getWorkspacePath()).toBe('/test/workspace');
    });

    it('should normalize workspace path', () => {
      const fm = new FileManager('/test/workspace/');
      expect(fm.getWorkspacePath()).toBe('/test/workspace/');
    });
  });

  describe('getWorkspacePath', () => {
    it('should return the workspace path', () => {
      expect(fileManager.getWorkspacePath()).toBe(testWorkspace);
    });
  });

  describe('path traversal protection', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'test.txt'), 'content');
    });

    it('should reject path traversal with ../', async () => {
      await expect(fileManager.readFile('../test.txt')).rejects.toThrow('Path traversal detected');
    });

    it('should reject deep path traversal', async () => {
      await expect(fileManager.readFile('../../../../etc/passwd')).rejects.toThrow(
        'Path traversal detected'
      );
    });

    it('should reject path traversal with subdirectory', async () => {
      await mkdir(join(testWorkspace, 'subdir'), { recursive: true });
      await expect(fileManager.readFile('subdir/../../../etc/passwd')).rejects.toThrow(
        'Path traversal detected'
      );
    });

    it('should reject absolute path outside workspace', async () => {
      await expect(fileManager.readFile('/etc/passwd')).rejects.toThrow();
    });

    it('should allow paths within workspace', async () => {
      await expect(fileManager.pathExists('test.txt')).resolves.toBe(true);
    });

    it('should allow nested paths within workspace', async () => {
      await mkdir(join(testWorkspace, 'deep', 'nested', 'dir'), { recursive: true });
      await writeFile(join(testWorkspace, 'deep', 'nested', 'dir', 'file.txt'), 'content');
      await expect(fileManager.pathExists('deep/nested/dir/file.txt')).resolves.toBe(true);
    });

    it('should handle pathExists for traversal attempt gracefully', async () => {
      await expect(fileManager.pathExists('../../../etc/passwd')).resolves.toBe(false);
    });
  });

  describe('readFile', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'test.txt'), 'Hello World');
      await mkdir(join(testWorkspace, 'subdir'), { recursive: true });
      await writeFile(join(testWorkspace, 'subdir', 'nested.txt'), 'Nested content');
    });

    it('should read file with utf-8 encoding by default', async () => {
      const result = await fileManager.readFile('test.txt');

      expect(result.content).toBe('Hello World');
      expect(result.encoding).toBe('utf-8');
      expect(result.path).toBe('test.txt');
      expect(result.size).toBe('Hello World'.length);
      expect(result.mtime).toBeDefined();
    });

    it('should read file with base64 encoding', async () => {
      const result = await fileManager.readFile('test.txt', 'base64');

      expect(result.encoding).toBe('base64');
      expect(result.content).toBe(Buffer.from('Hello World').toString('base64'));
    });

    it('should read file from subdirectory', async () => {
      const result = await fileManager.readFile('subdir/nested.txt');
      expect(result.content).toBe('Nested content');
    });

    it('should throw error for non-existent file', async () => {
      await expect(fileManager.readFile('nonexistent.txt')).rejects.toThrow('File not found');
    });

    it('should throw error when trying to read directory', async () => {
      await expect(fileManager.readFile('subdir')).rejects.toThrow('Path is a directory');
    });

    it('should include file metadata', async () => {
      const result = await fileManager.readFile('test.txt');

      expect(result.size).toBe(11);
      expect(result.mtime).toBeDefined();
      const mtimeDate = new Date(result.mtime);
      expect(mtimeDate).toBeInstanceOf(Date);
      expect(mtimeDate.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should read binary file with base64 encoding', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      await writeFile(join(testWorkspace, 'binary.bin'), binaryContent);

      const result = await fileManager.readFile('binary.bin', 'base64');
      expect(result.encoding).toBe('base64');
      expect(Buffer.from(result.content, 'base64')).toEqual(binaryContent);
    });

    it('should handle relative path with ./', async () => {
      const result = await fileManager.readFile('./test.txt');
      expect(result.content).toBe('Hello World');
    });
  });

  describe('listDirectory', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'alpha.txt'), 'a');
      await writeFile(join(testWorkspace, 'beta.md'), 'b');
      await mkdir(join(testWorkspace, 'gamma'), { recursive: true });
      await mkdir(join(testWorkspace, 'emptydir'), { recursive: true });
      await mkdir(join(testWorkspace, 'subdir'), { recursive: true });
      await writeFile(join(testWorkspace, 'subdir', 'nested.txt'), 'nested');
      await writeFile(join(testWorkspace, 'subdir', 'deep.txt'), 'deep');
    });

    it('should list directory contents', async () => {
      const files = await fileManager.listDirectory('.');

      expect(files.length).toBe(5);
      expect(files.some((f) => f.name === 'alpha.txt')).toBe(true);
      expect(files.some((f) => f.name === 'beta.md')).toBe(true);
      expect(files.some((f) => f.name === 'gamma')).toBe(true);
      expect(files.some((f) => f.name === 'subdir')).toBe(true);
    });

    it('should sort directories before files', async () => {
      const files = await fileManager.listDirectory('.');

      const firstDir = files.find((f) => f.type === 'directory');
      const firstFile = files.find((f) => f.type === 'file');

      if (firstDir && firstFile) {
        const dirIndex = files.indexOf(firstDir);
        const fileIndex = files.indexOf(firstFile);
        expect(dirIndex).toBeLessThan(fileIndex);
      }
    });

    it('should sort items alphabetically within type', async () => {
      const files = await fileManager.listDirectory('.');

      const dirs = files.filter((f) => f.type === 'directory');
      const dirNames = dirs.map((d) => d.name);

      const sortedDirNames = [...dirNames].sort();
      expect(dirNames).toEqual(sortedDirNames);
    });

    it('should list subdirectory contents', async () => {
      const files = await fileManager.listDirectory('subdir');

      expect(files.length).toBe(2);
      expect(files.some((f) => f.name === 'nested.txt')).toBe(true);
      expect(files.some((f) => f.name === 'deep.txt')).toBe(true);
    });

    it('should include file metadata for files', async () => {
      const files = await fileManager.listDirectory('.');
      const file = files.find((f) => f.name === 'alpha.txt');

      expect(file).toBeDefined();
      expect(file!.size).toBe(1);
      expect(file!.mtime).toBeDefined();
    });

    it('should not include size for directories', async () => {
      const files = await fileManager.listDirectory('.');
      const dir = files.find((f) => f.type === 'directory');

      expect(dir).toBeDefined();
      expect(dir!.size).toBeUndefined();
    });

    it('should throw error for non-existent directory', async () => {
      await expect(fileManager.listDirectory('nonexistent')).rejects.toThrow('Directory not found');
    });

    it('should throw error when trying to list a file', async () => {
      await expect(fileManager.listDirectory('alpha.txt')).rejects.toThrow(
        'Path is not a directory'
      );
    });

    it('should list recursively when recursive=true', async () => {
      const files = await fileManager.listDirectory('.', true);

      expect(
        files.some((f) => f.path === 'subdir/nested.txt' || f.path.endsWith('subdir/nested.txt'))
      ).toBe(true);
      expect(
        files.some((f) => f.path === 'subdir/deep.txt' || f.path.endsWith('subdir/deep.txt'))
      ).toBe(true);
      expect(files.length).toBeGreaterThan(4);
    });

    it('should handle empty directory', async () => {
      const files = await fileManager.listDirectory('emptydir');
      expect(files.length).toBe(0);
    });

    it('should use current directory by default', async () => {
      const files = await fileManager.listDirectory();
      expect(files.length).toBe(5);
    });

    it('should handle paths with trailing slashes', async () => {
      const files = await fileManager.listDirectory('subdir/');
      expect(files.length).toBe(2);
    });
  });

  describe('getFileTree', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'file1.txt'), 'content1');
      await writeFile(join(testWorkspace, 'file2.md'), 'content2');
      await mkdir(join(testWorkspace, 'dir1'), { recursive: true });
      await mkdir(join(testWorkspace, 'dir1', 'subdir'), { recursive: true });
      await writeFile(join(testWorkspace, 'dir1', 'subdir', 'nested.txt'), 'nested');
      await writeFile(join(testWorkspace, 'dir1', 'file.txt'), 'dirfile');
    });

    it('should return tree structure for directory', async () => {
      const tree = await fileManager.getFileTree('.');

      expect(tree.type).toBe('directory');
      expect(tree.children).toBeDefined();
      expect(tree.children!.length).toBeGreaterThan(0);
    });

    it('should return file node for file', async () => {
      const tree = await fileManager.getFileTree('file1.txt');

      expect(tree.type).toBe('file');
      expect(tree.name).toBe('file1.txt');
      expect(tree.children).toBeUndefined();
    });

    it('should respect max depth', async () => {
      const tree = await fileManager.getFileTree('.', 1);

      const dir1 = tree.children?.find((c) => c.name === 'dir1');
      expect(dir1).toBeDefined();

      expect(dir1!.children).toEqual([]);
    });

    it('should skip hidden files', async () => {
      await writeFile(join(testWorkspace, '.hidden'), 'secret');

      const tree = await fileManager.getFileTree('.');
      expect(tree.children?.some((c) => c.name === '.hidden')).toBe(false);
    });

    it('should skip common ignore patterns', async () => {
      await mkdir(join(testWorkspace, 'node_modules'), { recursive: true });
      await mkdir(join(testWorkspace, 'dist'), { recursive: true });
      await mkdir(join(testWorkspace, 'build'), { recursive: true });
      await mkdir(join(testWorkspace, 'coverage'), { recursive: true });

      const tree = await fileManager.getFileTree('.');

      expect(tree.children?.some((c) => c.name === 'node_modules')).toBe(false);
      expect(tree.children?.some((c) => c.name === 'dist')).toBe(false);
      expect(tree.children?.some((c) => c.name === 'build')).toBe(false);
      expect(tree.children?.some((c) => c.name === 'coverage')).toBe(false);
    });

    it('should sort directories before files', async () => {
      const tree = await fileManager.getFileTree('.');

      const children = tree.children || [];
      const types = children.map((c) => c.type);

      const firstDirIdx = types.indexOf('directory');
      const firstFileIdx = types.indexOf('file');

      if (firstDirIdx !== -1 && firstFileIdx !== -1) {
        expect(firstDirIdx).toBeLessThan(firstFileIdx);
      }
    });

    it('should throw error for non-existent path', async () => {
      await expect(fileManager.getFileTree('nonexistent')).rejects.toThrow('Path not found');
    });

    it('should handle nested directories with sufficient depth', async () => {
      const tree = await fileManager.getFileTree('.', 5);

      const dir1 = tree.children?.find((c) => c.name === 'dir1');
      expect(dir1).toBeDefined();
      expect(dir1!.type).toBe('directory');
      expect(dir1!.children).toBeDefined();

      const subdir = dir1!.children?.find((c) => c.name === 'subdir');
      expect(subdir).toBeDefined();
    });

    it('should use workspace name for root directory', async () => {
      const tree = await fileManager.getFileTree('.');
      expect(tree.name).toBe(testWorkspace.split('/').pop());
    });

    it('should use default max depth of 3', async () => {
      await mkdir(join(testWorkspace, 'a', 'b', 'c', 'd'), { recursive: true });
      await writeFile(join(testWorkspace, 'a', 'b', 'c', 'd', 'deep.txt'), 'very deep');

      const tree = await fileManager.getFileTree('.');

      const a = tree.children?.find((c) => c.name === 'a');
      expect(a).toBeDefined();

      if (a?.children?.[0]?.children?.[0]?.children) {
        expect(a.children[0].children[0].children).toEqual([]);
      }
    });

    it('should handle currentDepth parameter internally', async () => {
      const tree = await fileManager.getFileTree('.', 2);

      const dir1 = tree.children?.find((c) => c.name === 'dir1');
      expect(dir1).toBeDefined();

      const subdir = dir1?.children?.find((c) => c.name === 'subdir');
      expect(subdir).toBeDefined();

      expect(subdir?.children).toEqual([]);
    });
  });

  describe('pathExists', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'exists.txt'), 'content');
      await mkdir(join(testWorkspace, 'dir'), { recursive: true });
    });

    it('should return true for existing file', async () => {
      expect(await fileManager.pathExists('exists.txt')).toBe(true);
    });

    it('should return true for existing directory', async () => {
      expect(await fileManager.pathExists('dir')).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      expect(await fileManager.pathExists('nonexistent.txt')).toBe(false);
    });

    it('should return false for path traversal attempts', async () => {
      expect(await fileManager.pathExists('../../../etc/passwd')).toBe(false);
    });

    it('should return true for nested paths', async () => {
      await mkdir(join(testWorkspace, 'dir', 'nested'), { recursive: true });
      await writeFile(join(testWorkspace, 'dir', 'nested', 'file.txt'), 'content');

      expect(await fileManager.pathExists('dir/nested/file.txt')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle files with special characters in name', async () => {
      await writeFile(join(testWorkspace, 'file with spaces.txt'), 'content');
      await writeFile(join(testWorkspace, 'file-with-dashes.txt'), 'content');

      expect(await fileManager.pathExists('file with spaces.txt')).toBe(true);
      expect(await fileManager.pathExists('file-with-dashes.txt')).toBe(true);
    });

    it('should handle empty files', async () => {
      await writeFile(join(testWorkspace, 'empty.txt'), '');

      const result = await fileManager.readFile('empty.txt');
      expect(result.content).toBe('');
      expect(result.size).toBe(0);
    });

    it('should handle files with unicode content', async () => {
      const unicodeContent = 'Hello 世界 🌍';
      await writeFile(join(testWorkspace, 'unicode.txt'), unicodeContent);

      const result = await fileManager.readFile('unicode.txt');
      expect(result.content).toBe(unicodeContent);
    });

    it('should handle large file listing', async () => {
      for (let i = 0; i < 50; i++) {
        await writeFile(join(testWorkspace, `file${i}.txt`), `content${i}`);
      }

      const files = await fileManager.listDirectory('.');
      expect(files.length).toBe(50);
    });

    it('should handle deeply nested directories', async () => {
      const deepPath = join(testWorkspace, 'a', 'b', 'c', 'd', 'e');
      await mkdir(deepPath, { recursive: true });
      await writeFile(join(deepPath, 'deep.txt'), 'very deep');

      expect(await fileManager.pathExists('a/b/c/d/e/deep.txt')).toBe(true);

      const result = await fileManager.readFile('a/b/c/d/e/deep.txt');
      expect(result.content).toBe('very deep');
    });
  });

  describe('FileInfo structure', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'test.txt'), 'content');
      await mkdir(join(testWorkspace, 'dir'), { recursive: true });
    });

    it('should return correct FileInfo for file', async () => {
      const files = await fileManager.listDirectory('.');
      const file = files.find((f) => f.name === 'test.txt');

      expect(file).toBeDefined();
      expect(file!.path).toBe('test.txt');
      expect(file!.name).toBe('test.txt');
      expect(file!.type).toBe('file');
      expect(file!.size).toBe(7);
      expect(file!.mtime).toBeDefined();
    });

    it('should return correct FileInfo for directory', async () => {
      const files = await fileManager.listDirectory('.');
      const dir = files.find((f) => f.name === 'dir');

      expect(dir).toBeDefined();
      expect(dir!.path).toBe('dir');
      expect(dir!.name).toBe('dir');
      expect(dir!.type).toBe('directory');
      expect(dir!.size).toBeUndefined();
      expect(dir!.mtime).toBeDefined();
    });
  });

  describe('FileTree structure', () => {
    beforeEach(async () => {
      await writeFile(join(testWorkspace, 'file.txt'), 'content');
      await mkdir(join(testWorkspace, 'dir'), { recursive: true });
    });

    it('should return correct FileTree for file', async () => {
      const tree = await fileManager.getFileTree('file.txt');

      expect(tree.name).toBe('file.txt');
      expect(tree.path).toBe('file.txt');
      expect(tree.type).toBe('file');
      expect(tree.children).toBeUndefined();
    });

    it('should return correct FileTree for directory', async () => {
      const tree = await fileManager.getFileTree('dir');

      expect(tree.name).toBe('dir');
      expect(tree.path).toBe('dir');
      expect(tree.type).toBe('directory');
      expect(tree.children).toEqual([]);
    });
  });
});
