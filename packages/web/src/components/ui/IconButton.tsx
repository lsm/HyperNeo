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
    'inline-flex items-center justify-center rounded-lg transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-950 disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    ghost: 'hover:bg-dark-800 text-gray-400 hover:text-gray-100',
    solid: 'bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-gray-100',
    default: 'bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-gray-100',
    danger: 'hover:bg-red-500/10 text-red-400 hover:text-red-300',
  };

  const sizes = {
    sm: 'p-1.5',
    md: 'p-2',
    lg: 'p-3',
  };

  const activeStyles = active ? 'bg-indigo-500/20 text-indigo-400' : '';

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
