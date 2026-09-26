export function CloneIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"
        stroke-width={1.6}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
