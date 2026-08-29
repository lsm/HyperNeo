import { ComponentChildren, JSX } from 'preact';
import { cn } from '../../lib/utils.ts';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'warning'
  | 'approve'
  | 'interrupt';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'size' | 'loading' | 'icon'> {
  children: ComponentChildren;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
  class?: string;
  icon?: ComponentChildren;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  disabled = false,
  loading = false,
  onClick,
  type = 'button',
  class: className,
  icon,
  ...rest
}: ButtonProps) {
  const baseStyles = cn(
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium',
    'transition-all duration-150 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50 disabled:cursor-not-allowed'
  );

  const variants = {
    primary:
      'bg-accent-hover hover:bg-accent-hover text-accent-fg shadow-sm hover:shadow active:scale-[0.98]',
    secondary:
      'bg-surface-raised hover:bg-fill-strong text-fg border border-line-strong hover:border-line-strong active:scale-[0.98]',
    ghost: 'hover:bg-surface-raised text-fg-soft hover:text-fg active:scale-[0.98]',
    danger: 'bg-danger hover:bg-danger text-accent-fg shadow-sm hover:shadow active:scale-[0.98]',
    warning:
      'bg-yellow-600 hover:bg-yellow-700 text-accent-fg shadow-sm hover:shadow active:scale-[0.98]',
    approve:
      'bg-emerald-600 hover:bg-emerald-700 text-accent-fg shadow-sm hover:shadow active:scale-[0.98]',
    interrupt:
      'border border-warning text-warning bg-transparent hover:bg-warning/10 active:scale-[0.98]',
  };

  const sizes = {
    xs: 'h-6 px-2 text-xs',
    sm: 'text-sm px-3 py-1.5',
    md: 'text-sm px-4 py-2',
    lg: 'text-base px-6 py-3',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      class={cn(baseStyles, variants[variant], sizes[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {loading && (
        <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
            fill="none"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      )}
      {icon && !loading && icon}
      {children}
    </button>
  );
}
