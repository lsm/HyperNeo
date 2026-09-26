import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export function TemplateListItem({
  template,
  isUserTemplate,
  onEdit,
  onDelete,
  onClone,
}: {
  template: SpaceLongHorizonAgentTemplate;
  isUserTemplate: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onClone?: () => void;
}) {
  return (
    <div class="st-trow">
      <span class="st-trow-name">{template.displayName}</span>
      {!isUserTemplate && <span class="st-chip">Built-in</span>}
      <span class="st-trow-desc">{template.description}</span>
      {(onEdit || onDelete || onClone) && (
        <span class="st-trow-acts">
          {onClone && (
            <button
              type="button"
              onClick={onClone}
              aria-label={`Clone template ${template.displayName}`}
              class="st-act"
            >
              Clone
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit template ${template.displayName}`}
              class="st-act"
            >
              Edit
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete template ${template.displayName}`}
              class="st-act st-act-danger"
            >
              Delete
            </button>
          )}
        </span>
      )}
    </div>
  );
}
