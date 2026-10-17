import { randomUUID } from 'node:crypto';
import {
  type AnthropicMessagesBridgeServer,
  createAnthropicMessagesBridgeServer,
} from './anthropic-messages-bridge/server.js';

type KeyedEnv = {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_CUSTOM_HEADERS?: string;
};

type KeyBridge = { server: AnthropicMessagesBridgeServer; accessToken: string };

const KEYED_PROVIDER_IDS = new Set([
  'glm',
  'kimi',
  'minimax',
  'deepseek',
  'openrouter',
  'opencode',
]);

const readyBridges = new Map<string, KeyBridge>();
const startingBridges = new Map<string, Promise<KeyBridge>>();
const scopeBridgeKeys = new Map<string, string>();

function isDaemonToken(token: string): boolean {
  if (token.startsWith('opencode:')) return true;
  for (const bridge of readyBridges.values()) if (bridge.accessToken === token) return true;
  return false;
}

function keyedUpstream(providerId: string, env: KeyedEnv) {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const bearer = env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = bearer || env.ANTHROPIC_API_KEY;
  if (!KEYED_PROVIDER_IDS.has(providerId) || !baseUrl || !apiKey || isDaemonToken(apiKey)) {
    return undefined;
  }
  const forwardHeaders = (env.ANTHROPIC_CUSTOM_HEADERS ?? '')
    .split('\n')
    .map((line) => line.split(':')[0].trim())
    .filter(Boolean);
  const headers: Record<string, string> = bearer
    ? { Authorization: `Bearer ${bearer}` }
    : { 'x-api-key': apiKey };
  return {
    baseUrl,
    headers,
    forwardHeaders,
    key: JSON.stringify([baseUrl, headers, forwardHeaders]),
  };
}

function retireScopeBridge(scope: string, nextKey: string): void {
  const previousKey = scopeBridgeKeys.get(scope);
  scopeBridgeKeys.set(scope, nextKey);
  if (!previousKey || previousKey === nextKey) return;
  if ([...scopeBridgeKeys.values()].includes(previousKey)) return;
  readyBridges.get(previousKey)?.server.stop();
  readyBridges.delete(previousKey);
}

export async function startProviderKeyBridge(
  providerId: string,
  env: KeyedEnv,
  scope: string = providerId
): Promise<void> {
  const upstream = keyedUpstream(providerId, env);
  if (!upstream) return;
  retireScopeBridge(scope, upstream.key);
  if (readyBridges.has(upstream.key)) return;
  let starting = startingBridges.get(upstream.key);
  if (!starting) {
    const accessToken = randomUUID();
    starting = createAnthropicMessagesBridgeServer({
      baseUrl: upstream.baseUrl,
      headers: upstream.headers,
      forwardHeaders: upstream.forwardHeaders,
      accessToken,
    })
      .then((server) => {
        const bridge = { server, accessToken };
        readyBridges.set(upstream.key, bridge);
        return bridge;
      })
      .finally(() => startingBridges.delete(upstream.key));
    startingBridges.set(upstream.key, starting);
  }
  await starting;
}

export function shieldProviderKey<T extends KeyedEnv>(providerId: string, env: T): T {
  const upstream = keyedUpstream(providerId, env);
  if (!upstream) return env;
  const bridge = readyBridges.get(upstream.key);
  if (!bridge) throw new Error(`Provider '${providerId}' key bridge is not started`);
  return {
    ...env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.server.port}`,
    ANTHROPIC_AUTH_TOKEN: bridge.accessToken,
    ANTHROPIC_API_KEY: '',
  };
}
