import superpipe, { type PipelineAPI } from 'superpipe';

export type DeleteSpaceRejection = 'space_not_found';

export interface DeleteSpaceIo {
  fenceSpace: (spaceId: string) => Promise<boolean>;
  quiesceSpace?: (spaceId: string) => Promise<void>;
  removeSpace: (spaceId: string) => Promise<boolean>;
}

export type DeleteSpaceResult = { success: true } | DeleteSpaceRejection;

async function fenceSpace(
  io: DeleteSpaceIo,
  spaceId: string
): Promise<{ value: string } | { reason: DeleteSpaceRejection }> {
  const fenced = await io.fenceSpace(spaceId);
  return fenced ? { value: spaceId } : { reason: 'space_not_found' };
}

async function quiesceSpace(io: DeleteSpaceIo, deletion: string): Promise<void> {
  await io.quiesceSpace?.(deletion);
}

async function removeSpace(
  io: DeleteSpaceIo,
  deletion: string
): Promise<{ value: { success: true } } | { reason: DeleteSpaceRejection }> {
  const removed = await io.removeSpace(deletion);
  return removed ? { value: { success: true } } : { reason: 'space_not_found' };
}

export const runSpaceDeletion = (superpipe({})('delete-space') as PipelineAPI)
  .input(['io', 'spaceId'])
  .pipe(fenceSpace, ['io', 'spaceId'], 'result:deletion')
  .pipe(quiesceSpace, ['io', 'deletion'])
  .pipe(removeSpace, ['io', 'deletion'], 'result:deletion')
  .endAsync('deletion') as (io: DeleteSpaceIo, spaceId: string) => Promise<DeleteSpaceResult>;
