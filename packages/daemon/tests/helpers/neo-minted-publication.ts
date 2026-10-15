export function withMintedPublicationId<T extends { publicationId?: string }>(
  service: { newPublicationId(): string },
  input: T
): Omit<T, 'publicationId'> {
  const { publicationId, ...authored } = input;
  if (publicationId !== undefined) {
    const next = service.newPublicationId;
    service.newPublicationId = () => {
      service.newPublicationId = next;
      return publicationId;
    };
  }
  return authored;
}
