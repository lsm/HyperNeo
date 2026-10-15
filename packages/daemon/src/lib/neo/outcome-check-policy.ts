type Outcome = { text: string; check?: string | null; deliveredBy?: string | null };

function requireChecks<T extends Outcome>(
  items: readonly T[]
): { value: readonly T[] } | { reason: { ok: false; reason: string } } {
  const bound = items.filter((item) => item.check === 'coding.pr_opened' && !!item.deliveredBy);
  return bound.length
    ? {
        reason: {
          ok: false,
          reason: `opened_check_unbound: ${bound.map(({ text }) => JSON.stringify(text)).join('; ')} is bound to a card; coding.pr_opened only fits an unbound outcome that a pull request is open.`,
        },
      }
    : { value: items };
}

export const neoOutcomeCheckPolicy = { requireChecks };
