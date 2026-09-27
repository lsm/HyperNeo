import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { ConfirmModal } from '../ui/ConfirmModal';

export function TemplateDeleteDialog({
  template,
  restoresBuiltIn = false,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  template: SpaceLongHorizonAgentTemplate;
  restoresBuiltIn?: boolean;
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
      title={restoresBuiltIn ? 'Restore Built-in Default' : 'Delete Template'}
      message={
        restoresBuiltIn
          ? `Remove your customization of "${template.displayName}"? The shipped built-in template takes over again. Agents already created from it keep their configuration.`
          : `Delete template "${template.displayName}"? This cannot be undone. Runs that pinned a template snapshot keep their copy. Older in-flight runs cannot be repaired by editing a workflow — let them finish or restart them first. Saved workflows still naming this template must be re-pointed, or their future runs cannot start that agent.`
      }
      confirmText={restoresBuiltIn ? 'Restore default' : 'Delete'}
      confirmButtonVariant="danger"
      isLoading={busy}
      error={error}
      confirmTestId="confirm-delete-template"
    />
  );
}
