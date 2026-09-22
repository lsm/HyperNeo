import type { Database } from '../../storage/sqlite-compat.ts';
import { editStandaloneTask } from '../../storage/tasks/edit-task.ts';
import { setStandaloneTaskDependencies } from '../../storage/tasks/set-task-dependencies.ts';
import { createTaskMetadataEditor } from './metadata-editor.ts';

export function createStandaloneTaskMetadataEditor(db: Database, notifyChange: () => void) {
  return createTaskMetadataEditor({
    resolveOwner: (taskId) =>
      db.prepare('SELECT id FROM space_tasks WHERE id = ? AND space_id IS NULL').get(taskId)
        ? { kind: 'standalone' }
        : null,
    admit: () => {},
    replaceDependencies: (_owner, input) => setStandaloneTaskDependencies(db, input, notifyChange),
    editStandalone: (input) => editStandaloneTask(db, input, notifyChange),
    editSpace: () => null,
  });
}
