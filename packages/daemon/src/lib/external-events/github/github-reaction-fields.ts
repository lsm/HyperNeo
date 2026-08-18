export function isPositiveReaction(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const content = (row as { content?: unknown }).content;
  return content === '+1' || content === 'thumbs_up';
}

export function reactionIdFrom(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const id = (row as { id?: unknown }).id;
  return typeof id === 'number' ? String(id) : '';
}
