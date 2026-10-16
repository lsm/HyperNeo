export function withMintedPublicationId<T extends { publicationId?: string }>(
  _service: unknown,
  input: T
): Omit<T, 'publicationId'> & { requestId: string } {
  const { publicationId, ...authored } = input;
  return { ...authored, requestId: publicationId ?? 'send' };
}
