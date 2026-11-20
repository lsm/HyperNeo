import { resolve } from 'node:path';
import { comparePipelineVerdicts } from './pipeline-verdict-compare.ts';
import { reportPipelineVerdicts } from './pipeline-verdict-report.ts';
import { countPipelineRoutes, readRepositorySources } from './system-map.ts';

export function compareStrictPipelineSources(base: Map<string, string>, head: Map<string, string>) {
  const report = (sources: Map<string, string>) =>
    reportPipelineVerdicts(sources, (input) => countPipelineRoutes(input, true));
  return comparePipelineVerdicts(report(base), report(head));
}

if (import.meta.main) {
  try {
    const [base, head] = process.argv.slice(2);
    if (!base || !head || process.argv.length !== 4)
      throw new Error('Expected base and head repository directories');
    const result = compareStrictPipelineSources(
      readRepositorySources(resolve(base), true),
      readRepositorySources(resolve(head), true)
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.regressions.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
