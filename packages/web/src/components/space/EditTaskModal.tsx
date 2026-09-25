import type { SpaceTaskPriority } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { FORM_CONTROL_CLASS, FORM_LABEL_CLASS, FormActions } from '../ui/FormField.tsx';
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
      footer={
        <FormActions
          onCancel={() => {
            if (!busy) onCancel();
          }}
          cancelDisabled={busy}
          submitLabel="Save Changes"
          submitting={busy}
          submitDisabled={!canConfirm}
          onSubmit={handleConfirm}
          submitTestId="edit-task-confirm"
        />
      }
    >
      <div class="space-y-4" data-testid="edit-task-modal-content">
        <div>
          <label class={FORM_LABEL_CLASS} for="edit-task-title-input">
            Title
          </label>
          <input
            id="edit-task-title-input"
            data-testid="edit-task-title"
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            class={FORM_CONTROL_CLASS}
            disabled={busy}
            maxLength={200}
          />
        </div>

        <div>
          <label class={FORM_LABEL_CLASS} for="edit-task-description-input">
            Description
          </label>
          <textarea
            id="edit-task-description-input"
            data-testid="edit-task-description"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            class={`${FORM_CONTROL_CLASS} min-h-[120px] resize-y`}
            rows={6}
            disabled={busy}
            placeholder="Describe what this task should accomplish..."
          />
        </div>

        <div>
          <label class={FORM_LABEL_CLASS} for="edit-task-priority-select">
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
            class={FORM_CONTROL_CLASS}
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
          <p class="text-xs text-danger" role="alert" data-testid="edit-task-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
