import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../daemon/src/lib/data-dir.ts';
import { desktopOptIn, readDesktopTodos } from '../../daemon/src/lib/desktop/opt-in.ts';
import { createDesktopProxy } from '../../daemon/src/lib/desktop/mcp-proxy.ts';
import { serveDesktopMcp } from '../../daemon/src/lib/desktop/mcp-server.ts';
import { createDesktopTargetBroker } from '../../daemon/src/lib/desktop/target-broker.ts';
import {
  desktopRecordMissing,
  readDesktopDriverRecord,
} from '../../daemon/src/lib/desktop/stop-operation.ts';
import { Database } from '../../daemon/src/storage/sqlite-compat.ts';

export async function readDesktopBinding(worker: string) {
  const db = new Database(process.env.DB_PATH || join(getDataDir(), 'data', 'daemon.db'), {
    readonly: true,
  });
  try {
    const todo = desktopOptIn(readDesktopTodos(db, worker), worker);
    if (!todo) return null;
    try {
      const desktop = join(getDataDir(), 'desktop');
      const directory = join(desktop, 'workers', worker);
      for (const path of [desktop, join(desktop, 'workers'), directory]) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
          return null;
      }
      if (
        !desktopRecordMissing(join(directory, 'stopped')) ||
        !desktopRecordMissing(join(directory, 'starting'))
      )
        return null;
      const record = readDesktopDriverRecord(directory);
      return {
        todo_id: todo.id,
        worker_id: worker,
        driver_instance_id: `${record.pid}-${record.startedAt.seconds}-${record.startedAt.microseconds}`,
        target_app_id: null,
      };
    } catch {
      return null;
    }
  } finally {
    db.close();
  }
}

export async function runDesktopMcp(args: string[]) {
  if (args.length !== 2 || args[0] !== '--worker' || !/^[A-Za-z0-9_-]{1,64}$/.test(args[1]))
    throw new Error('Usage: hyperneo desktop-mcp --worker <id>');
  const proxy = createDesktopProxy({
    binding: () => readDesktopBinding(args[1]),
    dispatch: async () => {
      throw new Error('driver_unavailable');
    },
    audit: (line) => {
      process.stderr.write(line + '\n');
    },
    authorize: createDesktopTargetBroker(getDataDir()),
  });
  await serveDesktopMcp(proxy);
}
