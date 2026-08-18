import { createHash } from 'node:crypto';
import type { SpaceWorkflow } from '@hyperneo/shared';

export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((el) => stableStringify(el));
    return `[${parts.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function canonicalPayload(workflow: SpaceWorkflow): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...workflow };
  delete copy.createdAt;
  delete copy.updatedAt;
  delete copy.layout;
  delete copy.templateHash;
  return copy;
}

export interface ComputedDefinitionVersion {
  versionHash: string;
  payload: string;
}

export function computeDefinitionVersion(workflow: SpaceWorkflow): ComputedDefinitionVersion {
  const payload = stableStringify(canonicalPayload(workflow));
  const versionHash = createHash('sha256').update(payload).digest('hex');
  return { versionHash, payload };
}

export function verifyDefinitionVersion(payload: string, versionHash: string): boolean {
  return createHash('sha256').update(payload).digest('hex') === versionHash;
}

export function stableVersionTimestamp(versionHash: string): number {
  let h = 0;
  for (let i = 0; i < versionHash.length; i++) {
    h = (Math.imul(31, h) + versionHash.charCodeAt(i)) | 0;
  }
  return h;
}
