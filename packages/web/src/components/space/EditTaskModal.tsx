import type { SpaceTaskPriority } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Modal } from '../ui/Modal.tsx';

const PRIORITY_OPTIONS: Array<{ value: SpaceTaskPriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export interface EditTaskModalProps {
  isOpen: boolean;
  busy: boolean;
  initialTitle: string;
  initialDescription: string;
  initialPriority: SpaceTaskPriority;
  onCancel: () => void;
  onConfirm: (
    updates: Partial<{
      title: string;
      description: string;
      priority: SpaceTaskPriority;
    }>
  ) => void | Promise<void>;
  error?: string | null;
}

export function EditTaskModal({
  isOpen,
  busy,
  initialTitle,
  initialDescription,
  initialPriority,
  onCancel,
  onConfirm,
  error,
}: EditTaskModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [priority, setPriority] = useState(initialPriority);

  const baselineRef = useRef({
    title: initialTitle,
    description: initialDescription,
    priority: initialPriority,
  });

  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
      setDescription(initialDescription);
      setPriority(initialPriority);
      baselineRef.current = {
        title: initialTitle,
        description: initialDescription,
        priority: initialPriority,
      };
    }
  }, [isOpen]);

  const baseline = baselineRef.current;

  const hasChanges =
    title.trim() !== baseline.title.trim() ||
    description.trim() !== baseline.description.trim() ||
    priority !== baseline.priority;

  const trimmedTitle = title.trim();
  const canConfirm = hasChanges && trimmedTitle.length > 0 && !busy;

  const handleConfirm = (): void => {
    if (!canConfirm) return;
    const updates: Partial<{
      title: string;
      description: string;
      priority: SpaceTaskPriority;
    }> = {};
    if (title.trim() !== baseline.title.trim()) updates.title = trimmedTitle;
    if (description.trim() !== baseline.description.trim())
      updates.description = description.trim();
    if (priority !== baseline.priority) updates.priority = priority;
    if (Object.keys(updates).length === 0) return;
    void onConfirm(updates);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title="Edit Task"
      size="md"
    >
      <div class="space-y-4" data-testid="edit-task-modal-content">
        <div>
          <label class="block text-[11px] text-gray-400 mb-1" for="edit-task-title-input">
            Title
          </label>
          <input
            id="edit-task-title-input"
            data-testid="edit-task-title"
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
            disabled={busy}
            maxLength={200}
          />
        </div>

        <div>
          <label class="block text-[11px] text-gray-400 mb-1" for="edit-task-description-input">
            Description
          </label>
          <textarea
            id="edit-task-description-input"
            data-testid="edit-task-description"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none min-h-[120px] resize-y"
            rows={6}
            disabled={busy}
            placeholder="Describe what this task should accomplish..."
          />
        </div>

        <div>
          <label class="block text-[11px] text-gray-400 mb-1" for="edit-task-priority-select">
            Priority
          </label>
          <select
            id="edit-task-priority-select"
            data-testid="edit-task-priority"
            value={priority}
            onChange={(e) =>
              setPriority((e.target as HTMLSelectElement).value as SpaceTaskPriority)
            }
            onInput={(e) => setPriority((e.target as HTMLSelectElement).value as SpaceTaskPriority)}
            class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1.5 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
            disabled={busy}
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p class="text-xs text-red-400" role="alert" data-testid="edit-task-error">
            {error}
          </p>
        )}

        <div class="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={() => {
              if (!busy) onCancel();
            }}
            disabled={busy}
            class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            data-testid="edit-task-confirm"
            class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-600/50 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
