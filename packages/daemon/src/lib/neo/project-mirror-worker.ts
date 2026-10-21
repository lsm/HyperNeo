import { Database } from '../../storage/sqlite-compat.ts';
import type { PlaceGroup } from '../drivers/types.ts';
import { mirrorNeoWorkspaceProjects } from './project-mirror.ts';

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ dbPath: string; groups: PlaceGroup[] }>) => void;
  postMessage(result: { changed: boolean } | { error: string }): void;
};

worker.onmessage = ({ data }) => {
  let db: Database | undefined;
  let result: { changed: boolean } | { error: string };
  try {
    db = new Database(data.dbPath);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA synchronous=NORMAL');
    result = { changed: mirrorNeoWorkspaceProjects(db, data.groups) };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
  worker.postMessage(result);
};
