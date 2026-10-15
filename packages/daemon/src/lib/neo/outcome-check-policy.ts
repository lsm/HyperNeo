type Outcome = { text: string; check?: string | null; deliveredBy?: string | null };

function requireChecks(
  items: readonly Outcome[],
  registry: { ok: boolean; kinds?: readonly string[] }
): { value: readonly Outcome[] } | { reason: { ok: false; reason: string } } {
  const undeclared = items.filter((item) => item.check === undefined);
  const bound = items.filter((item) => item.check === 'coding.pr_opened' && !!item.deliveredBy);
  const quote = (list: readonly Outcome[]) =>
    list.map(({ text }) => JSON.stringify(text)).join('; ');
  if (undeclared.length)
    return {
      reason: {
        ok: false,
        reason: `check_required: ${quote(undeclared)} declares no check. Give every outcome check: one of ${(registry.kinds ?? []).join(', ')} for the daemon to tick it, or null when you tick it yourself.`,
      },
    };
  return bound.length
    ? {
        reason: {
          ok: false,
          reason: `opened_check_unbound: ${quote(bound)} is bound to a card; coding.pr_opened only fits an unbound outcome that a pull request is open.`,
        },
      }
    : { value: items };
}

export const neoOutcomeCheckPolicy = { requireChecks };
