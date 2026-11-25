import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const copilotWorkerDirectory = (dbPath: string) =>
  join(dirname(resolve(dbPath)), 'copilot-workers');

export const codexWorkerHome = () => join(homedir(), '.codex');

export const codexAppServerSocketPath = (codexHome = codexWorkerHome()) =>
  join(codexHome, 'app-server-control', 'app-server-control.sock');
