import type { ComponentChildren } from 'preact';

interface ContentContainerProps {
  children: ComponentChildren;
  className?: string;
}

export function ContentContainer({ children, className = '' }: ContentContainerProps) {
  const baseClasses = 'mx-auto px-4 w-full';
  const combinedClasses = className ? `${baseClasses} ${className}` : baseClasses;

  return <div class={combinedClasses}>{children}</div>;
}
