import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export function TemplateListItem({
  template,
  isBuiltIn,
  isUserTemplate,
  onEdit,
  onDelete,
}: {
  template: SpaceLongHorizonAgentTemplate;
  isBuiltIn: boolean;
  isUserTemplate: boolean;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const customized = isBuiltIn && isUserTemplate;
  return (
    <div class="st-trow">
      <div class="st-trow-body">
        <div class="flex min-w-0 items-center gap-2">
          <span class="st-trow-name truncate">{template.displayName}</span>
          {isBuiltIn && <span class="st-chip">Built-in</span>}
          {customized && <span class="st-chip st-chip-accent">Customized</span>}
          {(template.labels ?? []).map((label) => (
            <span key={label} class="st-chip">
              {label}
            </span>
          ))}
        </div>
        {template.description && (
          <p class="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{template.description}</p>
        )}
      </div>
      <span class="st-trow-acts">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit template ${template.displayName}`}
          class="st-act"
        >
          Edit
        </button>
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
    </div>
  );
}
