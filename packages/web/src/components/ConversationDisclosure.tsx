interface ConversationDisclosureProps {
  expanded: boolean;
  title: string;
  onToggle: () => void;
}

export function ConversationDisclosure({ expanded, title, onToggle }: ConversationDisclosureProps) {
  const label = `${expanded ? 'Hide' : 'Show'} child conversations for ${title}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={onToggle}
      class="flex h-8 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <svg
        class={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path d="m9 5 7 7-7 7" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  );
}
