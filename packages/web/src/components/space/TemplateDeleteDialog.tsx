import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { ConfirmModal } from '../ui/ConfirmModal';

interface TemplateDeleteState {
  busy: boolean;
  error: string | null;
}

const IDLE: TemplateDeleteState = { busy: false, error: null };

const deleteStates = signal<ReadonlyMap<string, TemplateDeleteState>>(new Map());

function writeDeleteState(key: string, next: TemplateDeleteState | null): void {
  const states = new Map(deleteStates.value);
  if (next) states.set(key, next);
  else states.delete(key);
  deleteStates.value = states;
}

export function TemplateDeleteDialog({
  template,
  onClose,
}: {
  template: SpaceLongHorizonAgentTemplate;
  onClose: () => void;
}) {
  const { busy, error } = deleteStates.value.get(template.key) ?? IDLE;

  const handleConfirm = async () => {
    writeDeleteState(template.key, { busy: true, error: null });
    try {
      await spaceStore.deleteTemplate(template.key, template.version);
      toast.success(`"${template.displayName}" deleted`);
      writeDeleteState(template.key, null);
      onClose();
    } catch (err) {
      writeDeleteState(template.key, {
        busy: false,
        error: err instanceof Error ? err.message : 'Failed to delete template',
      });
    }
  };

  const handleClose = () => {
    if (busy) return;
    writeDeleteState(template.key, null);
    onClose();
  };

  return (
    <ConfirmModal
      isOpen
      onClose={handleClose}
      onConfirm={handleConfirm}
      title="Delete Template"
      message={`Delete template "${template.displayName}"? This cannot be undone. Runs that pinned a template snapshot keep their copy. Older in-flight runs cannot be repaired by editing a workflow — let them finish or restart them first. Saved workflows still naming this template must be re-pointed, or their future runs cannot start that agent.`}
      confirmText="Delete"
      confirmButtonVariant="danger"
      isLoading={busy}
      error={error}
      confirmTestId="confirm-delete-template"
    />
  );
}
