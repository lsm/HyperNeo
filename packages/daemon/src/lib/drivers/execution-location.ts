import { isAbsolute } from 'node:path';
import type { WorkDetail } from './types.ts';

export function workExecutionLocation(
  directory: string | undefined,
  machine: string
): Pick<WorkDetail, 'execution'> {
  return directory && isAbsolute(directory) && machine.trim()
    ? { execution: { directory, machine } }
    : {};
}
