import { IconButton } from '../ui/IconButton.tsx';

interface Props {
  onClick?: () => void;
  title?: string;
}

export function MessageInfoButton({ onClick, title = 'Session info' }: Props) {
  return (
    <IconButton size="md" onClick={onClick} title={title}>
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </IconButton>
  );
}
