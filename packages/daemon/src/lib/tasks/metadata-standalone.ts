import type { Database } from '../../storage/sqlite-compat.ts';
import { editStandaloneTaskWithDependencies } from '../../storage/tasks/set-task-dependencies.ts';
import { createTaskMetadataEditor } from './metadata-editor.ts';

export function createStandaloneTaskMetadataEditor(db: Database, notifyChange: () => void) {
  return createTaskMetadataEditor({
    resolveOwner: (taskId) =>
      db.prepare('SELECT id FROM space_tasks WHERE id = ? AND space_id IS NULL').get(taskId)
        ? { kind: 'standalone' }
        : null,
    admit: () => {},
    editStandalone: (input) => editStandaloneTaskWithDependencies(db, input, notifyChange),
    editSpace: () => null,
  });
}
