import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { ConfirmModal } from '../ui/ConfirmModal';

export function TemplateDeleteDialog({
  template,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  template: SpaceLongHorizonAgentTemplate;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
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
