import { NEO_PACK_COMPUTER_USE_WORKER } from '@hyperneo/prompts';
import catalog from './tool-catalog.json' with { type: 'json' };

export const DESKTOP_WORKER_TEMPLATE_KEY = 'worker.desktop';
export const DESKTOP_MCP_SERVER_NAME = 'desktop';
export const DESKTOP_WORKER_TOOLS = ['report', ...catalog.map(({ name }) => name)].map(
  (name) => `mcp__${DESKTOP_MCP_SERVER_NAME}__${name}`
);

export const DESKTOP_WORKER_PROMPT = NEO_PACK_COMPUTER_USE_WORKER;
