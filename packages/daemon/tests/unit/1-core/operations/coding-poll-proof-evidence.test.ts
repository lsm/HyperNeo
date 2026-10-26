import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Binding = {
  testedCodeCommit: string;
  testedGitTree: string;
  applicationTrees: { packages: string; scripts: string };
  runs: { bun: string; deno: string };
  postProofChangePolicy: string;
};
const evidence = new URL(
  '../../../../../../.claude/skills/verify/evidence/coding-poll-db/',
  import.meta.url
);

test('retained polling proofs identify one committed application tree for both runtimes', () => {
  const observed = JSON.parse(readFileSync(new URL('observed.json', evidence), 'utf8')) as {
    proofBinding?: Binding;
  };
  const binding = observed.proofBinding;
  expect(binding).toBeDefined();
  if (!binding) throw new Error('Polling proofs have no committed application binding');
  expect(binding.testedCodeCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(binding.testedGitTree).toMatch(/^[a-f0-9]{40}$/);
  expect(binding.applicationTrees.packages).toMatch(/^[a-f0-9]{40}$/);
  expect(binding.applicationTrees.scripts).toMatch(/^[a-f0-9]{40}$/);
  expect(binding.postProofChangePolicy).toBe('evidence-and-journey-only');
  for (const runtime of ['bun', 'deno'] as const) {
    const folder = binding.runs[runtime];
    expect(folder).toMatch(new RegExp(`^${runtime}-verify(?:-\\d+)?$`));
    const run = JSON.parse(readFileSync(new URL(`${folder}/run.json`, evidence), 'utf8')) as {
      head: string;
      runtime: string;
      mode: string;
      exitCode: number;
      temporaryDaemonDataRemoved: boolean;
    };
    const proof = JSON.parse(
      readFileSync(new URL(`${folder}/coding-poll-db.json`, evidence), 'utf8')
    ) as { verified: boolean; mainSql: string[] };
    expect(run.head).toBe(binding.testedCodeCommit);
    expect(run.runtime).toBe(runtime);
    expect(run.mode).toBe('verify');
    expect(run.exitCode).toBe(0);
    expect(run.temporaryDaemonDataRemoved).toBe(true);
    expect(proof.verified).toBe(true);
    expect(proof.mainSql).toEqual([]);
  }
});
