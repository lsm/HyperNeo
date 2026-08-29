import { IconButton } from '../ui/IconButton.tsx';

interface Props {
  onClick?: () => void;
  title?: string;
  isError?: boolean;
}

export function ResultInfoButton({ onClick, title = 'Run result', isError = false }: Props) {
  return (
    <IconButton size="md" onClick={onClick} title={title} class={isError ? 'text-warning' : ''}>
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </IconButton>
  );
}
