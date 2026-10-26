export async function releaseFailedStartup(
  actions: Array<() => unknown>,
  budgetMs = 5000
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (const action of actions) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
}
