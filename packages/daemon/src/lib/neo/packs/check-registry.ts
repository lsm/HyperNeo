import { z } from 'zod';
import type { NeoPack, NeoPackCheck } from './types.ts';

const CheckKind = z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/);

type Registration = { packId: string; check: NeoPackCheck; independent: boolean };
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
    for (const kind of Object.keys(pack.checkEvidence ?? {})) {
      if (!Object.hasOwn(pack.checks ?? {}, kind))
        return { ok: false, reason: `unregistered_check_metadata: ${kind}` };
    }
    for (const [kind, check] of Object.entries(pack.checks ?? {})) {
      if (!CheckKind.safeParse(kind).success || !kind.startsWith(`${pack.id}.`))
        return { ok: false, reason: `invalid_check_kind: ${kind}` };
      if (entries.has(kind)) return { ok: false, reason: `duplicate_check_kind: ${kind}` };
      entries.set(
        kind,
        Object.freeze({
          packId: pack.id,
          check,
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
