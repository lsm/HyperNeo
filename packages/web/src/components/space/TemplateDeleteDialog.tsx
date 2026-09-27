import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { ConfirmModal } from '../ui/ConfirmModal';

export function TemplateDeleteDialog({
  template,
  restoresBuiltIn = false,
  hidesBuiltIn = false,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  template: SpaceLongHorizonAgentTemplate;
  restoresBuiltIn?: boolean;
  hidesBuiltIn?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const title = hidesBuiltIn
    ? 'Hide Built-in Template'
    : restoresBuiltIn
      ? 'Restore Built-in Default'
      : 'Delete Template';
  const message = hidesBuiltIn
    ? `Hide "${template.displayName}" for this space? It leaves the template list and new agents can no longer be created from it. Agents and workflow snapshots already using it keep working. Bring it back anytime from the Hidden section below.`
    : restoresBuiltIn
      ? `Remove your customization of "${template.displayName}"? The shipped built-in template takes over again. Agents already created from it keep their configuration.`
      : `Delete template "${template.displayName}"? This cannot be undone. Runs that pinned a template snapshot keep their copy. Older in-flight runs cannot be repaired by editing a workflow — let them finish or restart them first. Saved workflows still naming this template must be re-pointed, or their future runs cannot start that agent.`;
  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      title={title}
      message={message}
      confirmText={hidesBuiltIn ? 'Hide' : restoresBuiltIn ? 'Restore default' : 'Delete'}
      confirmButtonVariant="danger"
      isLoading={busy}
      error={error}
      confirmTestId="confirm-delete-template"
    />
  );
}
