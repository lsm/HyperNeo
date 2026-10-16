export function neoHolderTitle(projectTitle: string): string {
  return `Neo · ${projectTitle}`;
}

export function planNeoHolderTitles(
  holders: readonly { sessionId: string; projectTitle: string; sessionTitle?: string }[]
): { sessionId: string; title: string }[] {
  return holders.flatMap((holder) =>
    holder.sessionTitle !== undefined && holder.sessionTitle !== neoHolderTitle(holder.projectTitle)
      ? [{ sessionId: holder.sessionId, title: neoHolderTitle(holder.projectTitle) }]
      : []
  );
}
