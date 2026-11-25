const PATHS = {
  full: 'M4 5h16M4 12h16M4 19h16',
  compact: 'M4 8.5h16M4 12h16M4 15.5h16',
  minimal: 'M4 12h16',
  schedules: 'M12 7.5v4.75l3 1.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  rename: 'M16.9 4.6a2 2 0 112.8 2.8L8 19.1 4 20l.9-4L16.9 4.6z',
  moveUnder: 'M5 5v8a3 3 0 003 3h10M14 12l4 4-4 4',
  moveTop: 'M5 19v-8a3 3 0 013-3h10M14 4l4 4-4 4',
  export: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  tools: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
  reset: 'M20 12a8 8 0 11-2.3-5.7M20 4v5h-5',
  archive: 'M4 6h16v4H4zM5 10v9h14v-9M10 14h4',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  id: 'M9 4L7 20M17 4l-2 16M4 9h16M3 15h16',
  copy: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
} as const;

export type ChatMenuGlyphName = keyof typeof PATHS;

export function ChatMenuGlyph({
  name,
  class: className,
}: {
  name: ChatMenuGlyphName;
  class?: string;
}) {
  return (
    <svg
      class={className ?? 'h-4 w-4'}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d={PATHS[name]} />
    </svg>
  );
}
