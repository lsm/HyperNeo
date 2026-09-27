const paths = {
  plus: 'M12 5v14M5 12h14',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h5',
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z',
  context: 'M5 7h14M5 12h10M5 17h6M19 14v6m-3-3h6',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  up: 'M12 19V5m-6 6 6-6 6 6',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4m-3 0h6',
  chevron: 'm8 14 4-4 4 4',
  close: 'm6 6 12 12M6 18 18 6',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  external: 'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
  work: 'M8 7V4h8v3M4 7h16v13H4V7Zm0 5c5 3 11 3 16 0M10 12h4',
  check: 'm5 12 4 4L19 6',
  pause: 'M9 5v14M15 5v14',
  back: 'm12 5-7 7 7 7M5 12h14',
};

export function NeoIcon({
  name,
  class: className = '',
}: {
  name: keyof typeof paths;
  class?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      class={`h-5 w-5 shrink-0 ${className}`}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function concernColor(id: string): string {
  const index = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;
  return [
    'text-accent bg-accent/10',
    'text-cat-teal bg-cat-teal/10',
    'text-cat-rose bg-cat-rose/10',
    'text-cat-violet bg-cat-violet/10',
  ][index];
}
