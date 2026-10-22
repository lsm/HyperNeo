export interface WorkerIdentity {
  id: string;
  adapter: string;
  name: string | null;
  label: string;
  daemon?: string;
}

const ENGINES: Record<string, string> = {
  'codex-desktop': 'Codex',
  'claude-code': 'Claude',
  'claude-desktop': 'Claude',
  'copilot-cli': 'Copilot',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  hyperneo: 'HyperNeo',
  space: 'Space',
};

export const isWorkerAdapter = (adapter: string): boolean => Object.hasOwn(ENGINES, adapter);

export const workerEngine = (adapter: string): string =>
  isWorkerAdapter(adapter) ? ENGINES[adapter] : adapter;

export function workerIdentity(
  ref: { id: string; adapter: string; daemon?: string },
  name: string | null
): WorkerIdentity {
  return { ...ref, name, label: `${workerEngine(ref.adapter)} · ${name ?? ref.id}` };
}
