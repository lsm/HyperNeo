export function CloneIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M6 20V4m0 12c0-6 12-2 12-8V4m-3 3 3-3 3 3M3 7l3-3 3 3"
        stroke-width={1.75}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
