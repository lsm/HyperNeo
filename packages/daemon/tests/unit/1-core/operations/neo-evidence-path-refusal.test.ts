import { expect, test } from 'bun:test';
import { neoEvidencePathRefusal } from '../../../../src/lib/neo/core-todo-checks.ts';

const evidence = (path: string) => ({ pack: 'core', kind: 'evidence', params: { path } });
const dataDir = '/var/hyperneo/data';

test('refuses new evidence inside the data directory regardless of case', () => {
  for (const path of [
    '/var/hyperneo/data',
    '/var/hyperneo/data/work/result.md',
    '/VAR/HYPERNEO/DATA/work/result.md',
  ]) {
    expect(neoEvidencePathRefusal(evidence(path), null, dataDir)).toBeTruthy();
  }
});

test('allows visible locations, artifacts, and unchanged legacy checks', () => {
  const legacy = evidence('/var/hyperneo/data/work/result.md');
  expect(neoEvidencePathRefusal(evidence('/home/person/result.md'), null, dataDir)).toBeNull();
  expect(
    neoEvidencePathRefusal(evidence('/var/hyperneo/database/result.md'), null, dataDir)
  ).toBeNull();
  expect(
    neoEvidencePathRefusal(
      { pack: 'core', kind: 'evidence', params: { artifact: 'a' } },
      null,
      dataDir
    )
  ).toBeNull();
  expect(
    neoEvidencePathRefusal(legacy, { ...legacy, params: { ...legacy.params } }, dataDir)
  ).toBeNull();
  expect(neoEvidencePathRefusal(legacy, evidence('/other/result.md'), dataDir)).toBeTruthy();
});
