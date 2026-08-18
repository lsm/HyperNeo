import { join, normalize, relative } from 'node:path';
import { stat, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface FileInfo {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
}

export interface FileTree {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTree[];
}

export class FileManager {
  constructor(private workspacePath: string) {}

  private validatePath(targetPath: string): string {
    const normalizedWorkspace = normalize(this.workspacePath);
    const normalizedTarget = normalize(join(this.workspacePath, targetPath));

    const rel = relative(normalizedWorkspace, normalizedTarget);

    if (rel.startsWith('..') || rel === '..') {
      throw new Error('Path traversal detected - access denied');
    }

    return normalizedTarget;
  }

  async readFile(
    filePath: string,
    encoding: 'utf-8' | 'base64' = 'utf-8'
  ): Promise<{
    path: string;
    content: string;
    encoding: string;
    size: number;
    mtime: string;
  }> {
    const absolutePath = this.validatePath(filePath);

    if (!existsSync(absolutePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = await stat(absolutePath);
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    let content: string;
    if (encoding === 'base64') {
      const bytes = await readFile(absolutePath);
      content = bytes.toString('base64');
    } else {
      content = await readFile(absolutePath, 'utf-8');
    }

    return {
      path: filePath,
      content,
      encoding,
      size: stats.size,
      mtime: stats.mtime.toISOString(),
    };
  }

  async listDirectory(dirPath: string = '.', recursive: boolean = false): Promise<FileInfo[]> {
    const absolutePath = this.validatePath(dirPath);

    if (!existsSync(absolutePath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${dirPath}`);
    }

    const files: FileInfo[] = [];

    if (recursive) {
      await this.walkDirectory(absolutePath, files);
    } else {
      const entries = await readdir(absolutePath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(absolutePath, entry.name);
        const entryStats = await stat(entryPath);
        const relativePath = relative(this.workspacePath, entryPath);

        files.push({
          path: relativePath,
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? entryStats.size : undefined,
          mtime: entryStats.mtime.toISOString(),
        });
      }
    }

    return files.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  private async walkDirectory(dirPath: string, files: FileInfo[]): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      const entryStats = await stat(entryPath);
      const relativePath = relative(this.workspacePath, entryPath);

      files.push({
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isFile() ? entryStats.size : undefined,
        mtime: entryStats.mtime.toISOString(),
      });

      if (entry.isDirectory()) {
        await this.walkDirectory(entryPath, files);
      }
    }
  }

  async getFileTree(
    dirPath: string = '.',
    maxDepth: number = 3,
    currentDepth: number = 0
  ): Promise<FileTree> {
    const absolutePath = this.validatePath(dirPath);

    if (!existsSync(absolutePath)) {
      throw new Error(`Path not found: ${dirPath}`);
    }

    const stats = await stat(absolutePath);
    const name =
      dirPath === '.'
        ? this.workspacePath.split('/').pop() || 'workspace'
        : dirPath.split('/').pop() || dirPath;

    if (!stats.isDirectory()) {
      return {
        name,
        path: dirPath,
        type: 'file',
      };
    }

    const tree: FileTree = {
      name,
      path: dirPath,
      type: 'directory',
      children: [],
    };

    if (currentDepth >= maxDepth) {
      return tree;
    }

    const entries: FileInfo[] = [];
    const dirEntries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (entry.name.startsWith('.')) continue;
      if (['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) {
        continue;
      }

      const entryPath = join(absolutePath, entry.name);
      const relativePath = relative(this.workspacePath, entryPath);

      entries.push({
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (entry.type === 'directory') {
        const subtree = await this.getFileTree(entry.path, maxDepth, currentDepth + 1);
        tree.children!.push(subtree);
      } else {
        tree.children!.push({
          name: entry.name,
          path: entry.path,
          type: 'file',
        });
      }
    }

    return tree;
  }

  async pathExists(filePath: string): Promise<boolean> {
    try {
      const absolutePath = this.validatePath(filePath);
      return existsSync(absolutePath);
    } catch {
      return false;
    }
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }
}
