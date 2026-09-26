import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export function TemplateListItem({
  template,
  isUserTemplate,
  onEdit,
  onDelete,
}: {
  template: SpaceLongHorizonAgentTemplate;
  isUserTemplate: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div class="st-trow">
      <div class="st-trow-body">
        <div class="flex min-w-0 items-center gap-2">
          <span class="st-trow-name truncate">{template.displayName}</span>
          {!isUserTemplate && <span class="st-chip">Built-in</span>}
        </div>
        {template.description && (
          <p class="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{template.description}</p>
        )}
      </div>
      {(onEdit || onDelete) && (
        <span class="st-trow-acts">
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
