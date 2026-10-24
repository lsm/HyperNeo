import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { editStandaloneTaskWithDependencies } from '../../storage/tasks/set-task-dependencies.ts';
import { createTaskMetadataEditor } from './metadata-editor.ts';

export function createStandaloneTaskMetadataEditor(db: Database, runOp: RunDbOp) {
  return createTaskMetadataEditor({
    resolveOwner: (taskId) =>
      db.prepare('SELECT id FROM space_tasks WHERE id = ? AND space_id IS NULL').get(taskId)
        ? { kind: 'standalone' }
        : null,
    admit: () => {},
    editStandalone: (input) => runOp(editStandaloneTaskWithDependencies, input),
    editSpace: () => null,
  });
}
