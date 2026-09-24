import { toChildArray, type ComponentChildren, type VNode } from 'preact';
import { cn } from '../../lib/utils.ts';
import { Button, type ButtonVariant } from './Button.tsx';

export const FORM_LABEL_CLASS = 'mb-1 block text-xs font-medium text-fg-muted';

export const FORM_CONTROL_CLASS =
  'w-full rounded border border-line bg-bg px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

export const FORM_CHECKBOX_CLASS =
  'h-4 w-4 rounded border-line-strong bg-surface-raised text-accent focus:ring-accent focus:ring-offset-0';

export function FormField({
  label,
  required = false,
  optional = false,
  class: className,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  const childArray = toChildArray(children);
  const onlyChild = childArray.length === 1 ? (childArray[0] as VNode) : null;
  const wrapsSingleControl =
    onlyChild != null &&
    typeof onlyChild.type === 'string' &&
    ['input', 'textarea', 'select'].includes(onlyChild.type);
  const caption = (
    <span class={FORM_LABEL_CLASS}>
      {label}
      {required && <span class="ml-1 text-danger">*</span>}
      {optional && <span class="ml-2 text-xs text-fg-faint">(optional)</span>}
    </span>
  );
  if (!wrapsSingleControl) {
    return (
      <div class={cn('block', className)}>
        {caption}
        {children}
      </div>
    );
  }
  return (
    <label class={cn('block', className)}>
      {caption}
      {children}
    </label>
  );
}

export function FormActions({
  error,
  onCancel,
  cancelLabel = 'Cancel',
  cancelDisabled = false,
  submitLabel,
  submitting = false,
  submitDisabled = false,
  submitVariant = 'primary',
  formId,
  onSubmit,
  submitTestId,
  children,
}: {
  error?: string | null;
  onCancel?: () => void;
  cancelLabel?: string;
  cancelDisabled?: boolean;
  submitLabel: string;
  submitting?: boolean;
  submitDisabled?: boolean;
  submitVariant?: ButtonVariant;
  formId?: string;
  onSubmit?: () => void;
  submitTestId?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="flex items-center justify-end gap-2">
      {error && (
        <p class="mr-auto truncate text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {children}
      {onCancel && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={cancelDisabled}
        >
          {cancelLabel}
        </Button>
      )}
      <Button
        type={formId ? 'submit' : 'button'}
        {...(formId ? { form: formId } : {})}
        variant={submitVariant}
        size="sm"
        onClick={onSubmit}
        loading={submitting}
        disabled={submitDisabled}
        {...(submitTestId ? { 'data-testid': submitTestId } : {})}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

export function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="space-y-3 rounded-lg border border-line bg-surface/60 p-3">
      <p class="text-xs font-semibold uppercase tracking-wider text-fg-muted">{title}</p>
      {hint && <p class="text-xs text-fg-faint">{hint}</p>}
      {children}
    </div>
  );
}
