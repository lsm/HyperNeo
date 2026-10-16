const NEO_KNOWN_LIMIT = 12;
const NEO_KNOWN_TITLE_CHARS = 50;

export function neoKnownIds(
  noun: string,
  known: readonly { id: string; title?: string }[]
): string {
  if (!known.length) return `There are no ${noun}.`;
  const shown = known
    .slice(0, NEO_KNOWN_LIMIT)
    .map(({ id, title }) => {
      const line = (title ?? '').trim().replace(/\s+/g, ' ');
      if (!line) return id;
      return `${id} "${line.length > NEO_KNOWN_TITLE_CHARS ? `${line.slice(0, NEO_KNOWN_TITLE_CHARS - 1)}…` : line}"`;
    })
    .join('; ');
  const more = known.length > NEO_KNOWN_LIMIT ? `; ${known.length - NEO_KNOWN_LIMIT} more` : '';
  return `Use one of the ${noun}: ${shown}${more}.`;
}
