export type CodingPollHttpMetadata = {
  cycle: string;
  status: number;
  headers: Record<string, string>;
};

export function pollHttpMetadata(
  cycle: string,
  status: number,
  input: Headers | Record<string, string>
): CodingPollHttpMetadata {
  const source = new Headers(input),
    headers: Record<string, string> = {};
  for (const name of [
    'etag',
    'last-modified',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-ratelimit-resource',
    'x-ratelimit-used',
    'retry-after',
  ]) {
    const value = source.get(name);
    if (value !== null) headers[name] = value;
  }
  return { cycle, status, headers };
}
