import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import superpipe, { type PipelineAPI } from 'superpipe';

const PRIVATE_MODE = 0o700;

type RootFacts = { symlink: boolean; uid: number; mode: number } | undefined;

export type DataRootStep =
  | { refuse: string }
  | { create: true }
  | { tighten: number }
  | { keep: true };

const octal = (mode: number) => mode.toString(8).padStart(4, '0');

function readRootFacts(root: string): RootFacts {
  try {
    const stat = lstatSync(root);
    return { symlink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function decideDataRoot(root: string, facts: RootFacts, euid?: number): DataRootStep {
  if (!facts) return { create: true };
  if (facts.symlink) return { refuse: `Data directory ${root} is a symlink; refusing to start` };
  if (euid !== undefined && facts.uid !== euid)
    return {
      refuse: `Data directory ${root} is owned by uid ${facts.uid}, not ${euid}; refusing to start`,
    };
  return facts.mode === PRIVATE_MODE ? { keep: true } : { tighten: facts.mode };
}

function applyDataRootStep(root: string, step: DataRootStep, log: (line: string) => void): true {
  if ('refuse' in step) throw new Error(step.refuse);
  process.umask(0o077);
  if ('create' in step) mkdirSync(root, { recursive: true, mode: PRIVATE_MODE });
  if ('tighten' in step) {
    chmodSync(root, PRIVATE_MODE);
    log(`Data directory ${root} tightened from ${octal(step.tighten)} to ${octal(PRIVATE_MODE)}`);
  }
  return true;
}

const secureDataRootPipeline = (superpipe({})('daemon.secure-data-root') as PipelineAPI)
  .input(['root', 'log', 'euid'])
  .pipe(readRootFacts, 'root', 'facts')
  .pipe(decideDataRoot, ['root', 'facts', 'euid'], 'step')
  .pipe(applyDataRootStep, ['root', 'step', 'log'], 'done')
  .end('done') as (root: string, log: (line: string) => void, euid?: number) => true;

export function secureDataRoot(
  root: string,
  { log, euid = process.geteuid?.() }: { log: (line: string) => void; euid?: number }
): void {
  secureDataRootPipeline(root, log, euid);
}
