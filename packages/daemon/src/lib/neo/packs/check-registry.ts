import { z } from 'zod';
import type { NeoPack, NeoPackCheck } from './types.ts';

const CheckKind = z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/);

type Evaluator =
  | { mode: 'evidence'; check: NeoPackCheck }
  | { mode: 'ask-ticks'; readAskTicks: NonNullable<NeoPack['readAskTicks']> };
type Registration = { packId: string; independent: boolean } & Evaluator;
type Refusal = { ok: false; reason: string };
type Registry = {
  ok: true;
  kinds: readonly string[];
  resolve: (kind: string) => { ok: true; value: Readonly<Registration> } | Refusal;
};

export function buildNeoCheckRegistry(packs: readonly NeoPack[]): Registry | Refusal {
  const entries = new Map<string, Readonly<Registration>>();
  const packIds = new Set<string>();
  for (const pack of packs) {
    if (packIds.has(pack.id)) return { ok: false, reason: `duplicate_pack: ${pack.id}` };
    packIds.add(pack.id);
    const declared: [string, Evaluator][] = Object.entries(pack.checks ?? {}).map(
      ([kind, check]) => [kind, { mode: 'evidence', check }]
    );
    for (const kind of pack.askTickChecks ?? []) {
      if (!pack.readAskTicks) return { ok: false, reason: `missing_tick_reader: ${kind}` };
      declared.push([kind, { mode: 'ask-ticks', readAskTicks: pack.readAskTicks }]);
    }
    for (const kind of Object.keys(pack.checkEvidence ?? {})) {
      if (!declared.some(([registered]) => registered === kind))
        return { ok: false, reason: `unregistered_check_metadata: ${kind}` };
    }
    for (const [kind, evaluator] of declared) {
      if (!CheckKind.safeParse(kind).success || !kind.startsWith(`${pack.id}.`))
        return { ok: false, reason: `invalid_check_kind: ${kind}` };
      if (entries.has(kind)) return { ok: false, reason: `duplicate_check_kind: ${kind}` };
      entries.set(
        kind,
        Object.freeze({
          packId: pack.id,
          ...evaluator,
          independent: pack.checkEvidence?.[kind]?.independent === true,
        })
      );
    }
  }
  return {
    ok: true,
    kinds: Object.freeze([...entries.keys()].sort()),
    resolve: (kind) => {
      const value = entries.get(kind);
      return value ? { ok: true, value } : { ok: false, reason: `unsupported_check: ${kind}` };
    },
  };
}
