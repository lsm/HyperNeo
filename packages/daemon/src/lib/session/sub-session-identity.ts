export function taskIdFromSubSessionIdentity(
  subSessionId: string,
  segment?: 'space' | 'task'
): string | null {
  const segments = subSessionId.split(':');
  const wanted = segment ?? 'task';
  const index = segments.indexOf(wanted);
  if (index === -1 || index + 1 >= segments.length) return null;
  return segments[index + 1] || null;
}

export function isWorkflowSubSessionIdentity(sessionId: string): boolean {
  const segments = sessionId.split(':');
  return (
    segments.includes('task') && (segments.includes('exec') || segments.includes('post-approval'))
  );
}
