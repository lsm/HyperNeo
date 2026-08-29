import { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';

export interface IconButtonProps {
  children: ComponentChildren;
  onClick?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'solid' | 'default' | 'danger';
  active?: boolean;
  class?: string;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
}

export function IconButton({
  children,
  onClick,
  disabled = false,
  size = 'md',
  variant = 'ghost',
  active = false,
  class: className,
  title,
  type = 'button',
}: IconButtonProps) {
  const baseStyles =
    'inline-flex items-center justify-center rounded-lg transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    ghost: 'hover:bg-surface-raised text-fg-muted hover:text-fg',
    solid: 'bg-surface-raised hover:bg-fill-strong text-fg-soft hover:text-fg',
    default: 'bg-surface-raised hover:bg-fill-strong text-fg-soft hover:text-fg',
    danger: 'hover:bg-danger/10 text-danger hover:text-danger-soft',
  };

  const sizes = {
    sm: 'p-1.5',
    md: 'p-2',
    lg: 'p-3',
  };

  const activeStyles = active ? 'bg-accent-hover/20 text-cat-indigo' : '';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      class={cn(baseStyles, variants[variant], sizes[size], activeStyles, className)}
    >
      {children}
    </button>
  );
}
