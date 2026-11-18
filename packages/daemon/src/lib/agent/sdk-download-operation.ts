import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { warmupSDKCliBinary, type WarmupResult } from './sdk-cli-resolver.ts';

const Input = z.object({}).default({});
const Result = z.union([
  z.object({ accepted: z.literal(true) }),
  z.object({ accepted: z.literal(false), reason: z.string() }),
]);
type Result = z.infer<typeof Result>;

function admit(input: z.infer<typeof Input>, caller: OperationCaller) {
  return caller.source === 'rpc'
    ? { value: input }
    : { reason: { accepted: false as const, reason: 'Only a local user can retry the download.' } };
}

async function retryDownload(
  _input: z.infer<typeof Input>,
  download: () => Promise<WarmupResult>
): Promise<Result> {
  const result = await download();
  return result.status === 'ready'
    ? { accepted: true }
    : { accepted: false, reason: `Can't download Claude Code: ${result.error}` };
}

const retry = (superpipe({})('daemon.retryClaudeDownload') as PipelineAPI)
  .input(['input', 'caller', 'download'])
  .pipe(admit, ['input', 'caller'], 'result:outcome')
  .pipe(retryDownload, ['outcome', 'download'], 'outcome')
  .endAsync('outcome') as (
  input: z.infer<typeof Input>,
  caller: OperationCaller,
  download: () => Promise<WarmupResult>
) => Promise<Result>;

export function createSdkDownloadOperation(download = warmupSDKCliBinary) {
  return defineOperation({
    name: 'daemon.retryClaudeDownload',
    description: 'Retry downloading Claude Code without restarting a conversation.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', caller: 'local_user' },
    execute: (input, caller) => retry(input, caller, download),
  });
}
