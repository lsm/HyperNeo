type NeoRuleRefusal = { reason: { ok: false; reason: string } };
const refuseRule = (reason: string): NeoRuleRefusal => ({ reason: { ok: false, reason } });

export function planNeoRuleEdit(
  current: readonly string[],
  edit: { add?: readonly string[]; remove?: readonly string[] }
): { value: string[] } | NeoRuleRefusal {
  const add = edit.add ?? [];
  const remove = edit.remove ?? [];
  if (!add.length && !remove.length) return refuseRule('Name a rule to add or remove.');
  const missing = remove.find((rule) => !current.includes(rule));
  if (missing !== undefined)
    return refuseRule(
      `"${missing}" is not a saved rule. Remove a rule by its exact text from neo.snapshot standingRules.`
    );
  const kept = current.filter((rule) => !remove.includes(rule));
  const rules = [...kept, ...[...new Set(add)].filter((rule) => !kept.includes(rule))];
  return { value: rules };
}

export function planNeoRuleSources(
  rules: readonly string[],
  current: Record<string, { sessionId: string; messageId: string }> = {},
  add: readonly string[] = [],
  approval?: { sessionId: string; messageId: string }
): Record<string, { sessionId: string; messageId: string }> {
  return Object.fromEntries([
    ...Object.entries(current).filter(([rule]) => rules.includes(rule)),
    ...(approval ? add.filter((rule) => rules.includes(rule)).map((rule) => [rule, approval]) : []),
  ]);
}
