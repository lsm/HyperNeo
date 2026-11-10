import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../daemon/src/storage/sqlite-compat.ts';
import { getConfig } from '../../daemon/src/config.ts';
import { getDataDir } from '../../daemon/src/lib/data-dir.ts';
import { createDesktopProxy } from '../../daemon/src/lib/desktop/mcp-proxy.ts';
import { createDriverTransport } from '../../daemon/src/lib/desktop/driver-transport.ts';
import { serveDesktopMcp } from '../../daemon/src/lib/desktop/mcp-server.ts';
import {
  readDesktopDriverRecord,
  desktopRecordMissing,
} from '../../daemon/src/lib/desktop/stop-operation.ts';

export async function readDesktopBinding(worker: string) {
  let db: Database | undefined;
  try {
    db = new Database(getConfig().dbPath, { readonly: true });
    const rows = db
      .prepare(`SELECT t.id, t.named FROM neo_todos t
      JOIN neo_asks a ON a.id = t.ask_id JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE t.state = 'doing' AND t.approved_at IS NOT NULL AND a.status = 'open'
      AND json_extract(s.ref, '$.id') = ? AND json_extract(s.ref, '$.daemon') IS NULL`)
      .all(worker) as { id: string; named: string | null }[];
    if (rows.length !== 1 || JSON.parse(rows[0].named ?? '{}').desktopControl !== true) return null;
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
      todo_id: rows[0].id,
      worker_id: worker,
      driver_instance_id: `${record.pid}-${record.startedAt.seconds}-${record.startedAt.microseconds}`,
      target_app_id: null,
      socket: record.socket,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function runDesktopMcp(args: string[]) {
  if (args.length !== 2 || args[0] !== '--worker' || !/^[A-Za-z0-9_-]{1,64}$/.test(args[1]))
    throw new Error('Usage: hyperneo desktop-mcp --worker <id>');
  const driver = createDriverTransport();
  const proxy = createDesktopProxy({
    binding: () => readDesktopBinding(args[1]),
    dispatch: driver.dispatch,
    audit: (line) => {
      process.stderr.write(line + '\n');
    },
  });
  await serveDesktopMcp(proxy, driver);
}
