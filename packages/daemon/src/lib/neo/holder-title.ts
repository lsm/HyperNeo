export function neoHolderTitle(projectTitle: string): string {
  return `Neo · ${projectTitle}`;
}

export function planNeoHolderTitles(
  holders: readonly {
    sessionId: string;
    projectTitle: string;
    sessionTitle?: string;
    titleSetBy?: string;
  }[]
): { sessionId: string; title: string }[] {
  return holders.flatMap((holder) =>
    holder.sessionTitle !== undefined &&
    holder.titleSetBy !== 'user' &&
    holder.sessionTitle !== neoHolderTitle(holder.projectTitle)
      ? [{ sessionId: holder.sessionId, title: neoHolderTitle(holder.projectTitle) }]
      : []
  );
}
