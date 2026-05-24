type FetchOptions = Parameters<typeof fetch>[1];

export function withoutAuthorization(options: FetchOptions): FetchOptions {
  if (!options?.headers) return options;
  const headers = new Headers(options.headers);
  headers.delete('authorization');
  return { ...options, headers };
}
