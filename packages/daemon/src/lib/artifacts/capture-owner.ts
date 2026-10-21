import { join } from 'node:path';
import type { Database } from '../../storage/sqlite-compat.ts';
import { createArtifactCaptureStore } from './capture-store.ts';

const owners = new WeakMap<Database, ReturnType<typeof createArtifactCaptureStore>>();
export function artifactCaptureOwner(db: Database, data: string) {
  let owner = owners.get(db);
  if (!owner) {
    owner = createArtifactCaptureStore(join(data, 'artifacts'));
    owners.set(db, owner);
  }
  return owner;
}
