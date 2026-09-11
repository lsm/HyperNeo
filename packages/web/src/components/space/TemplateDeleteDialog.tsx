import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { ConfirmModal } from '../ui/ConfirmModal';

export function TemplateDeleteDialog({
  template,
  onClose,
}: {
  template: SpaceLongHorizonAgentTemplate;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await spaceStore.deleteTemplate(template.key, template.version);
      toast.success(`"${template.displayName}" deleted`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
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
