import { mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Database } from '../../src/storage/sqlite-compat.ts';
import { createCodexDesktopAdapter } from '../../src/lib/drivers/codex-desktop-adapter.ts';

export function delayedWorktree(root: string, delayMs = 1400) {
  const folder = join(root, 'worktrees', 'wt');
  const project = join(root, 'repo');
  mkdirSync(folder, { recursive: true });
  mkdirSync(project);
  execFileSync('/usr/bin/mkfifo', [join(folder, '.git')]);
  const marker = join(root, 'reading');
  const writer = spawn(
    '/usr/bin/python3',
    [
      '-c',
      'import os,sys,time; print("READY",flush=True); fd=os.open(sys.argv[1],os.O_WRONLY); open(sys.argv[2],"w").write("reading"); time.sleep(float(sys.argv[3])/1000); os.write(fd,sys.argv[4].encode()); os.close(fd)',
      join(folder, '.git'),
      marker,
      String(delayMs),
      `gitdir: ${project}/.git/worktrees/wt\n`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const closed = new Promise<number | null>((done) => writer.once('exit', done));
  const ready = new Promise<void>((done, fail) => {
    writer.stdout.once('data', () => done());
    writer.once('error', fail);
  });
  return { folder, project, marker, writer, ready, closed };
}

export function syntheticCodex(root: string, folder: string, project: string) {
  const statePath = join(root, 'codex.sqlite');
  const db = new Database(statePath);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, updated_at_ms INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
    CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT,
      first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER)`);
  db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('p', 'Synthetic', Date.now());
  db.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run('p', 0, project);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread',
    'Synthetic thread',
    '',
    '',
    folder,
    'cli',
    0,
    Date.now()
  );
  db.close();
  return createCodexDesktopAdapter({
    statePath,
    worktreesDir: join(root, 'worktrees'),
    machine: 'synthetic',
    now: Date.now,
    spawn: () => {
      throw new Error('No process launch from synthetic discovery');
    },
    bootstrapServer: async () => {
      throw new Error('No app server');
    },
    prepareDesktopProject: async () => {
      throw new Error('No Desktop');
    },
    startDesktopTurn: async () => {
      throw new Error('No Desktop');
    },
    appServer: async () => {
      throw new Error('No app server');
    },
    folderExists: () => true,
    makeFolder: () => {},
    homeDir: root,
    gitCheckout: async () => null,
    newId: () => 'unused',
  });
}
