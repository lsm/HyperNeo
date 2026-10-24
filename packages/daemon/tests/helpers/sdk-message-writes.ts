export async function writeThroughRepo(
  this: { getSDKMessageRepo?: () => unknown },
  method: string,
  ...args: unknown[]
): Promise<never> {
  const repo = this.getSDKMessageRepo?.() as
    | Record<string, (...args: unknown[]) => unknown>
    | null
    | undefined;
  return repo?.[method](...args) as never;
}
