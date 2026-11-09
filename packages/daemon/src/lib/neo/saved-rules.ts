import { NEO_STANDING_RULES_MAX, type NeoRuleSource } from '@hyperneo/shared/types/settings';

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
      `"${missing}" is not a saved rule. Remove a rule by its exact text from the standing rules in your prompt.`
    );
  const kept = current.filter((rule) => !remove.includes(rule));
  const added = [...new Set(add)].filter((rule) => !kept.includes(rule));
  const rules = [...kept, ...added];
  return added.length && rules.length > NEO_STANDING_RULES_MAX
    ? refuseRule(`At most ${NEO_STANDING_RULES_MAX} rules are kept; remove one first.`)
    : { value: rules };
}

export function planNeoRuleSources(
  rules: readonly string[],
  current: Record<string, NeoRuleSource> = {},
  add: readonly string[] = [],
  approval?: NeoRuleSource
): Record<string, NeoRuleSource> {
  return Object.fromEntries([
    ...Object.entries(current).filter(([rule]) => rules.includes(rule)),
    ...(approval ? add.filter((rule) => rules.includes(rule)).map((rule) => [rule, approval]) : []),
  ]);
}
