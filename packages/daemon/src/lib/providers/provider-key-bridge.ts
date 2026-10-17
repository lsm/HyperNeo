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

const readyBridges = new Map<string, KeyBridge>();
const startingBridges = new Map<string, Promise<KeyBridge>>();

function isLoopback(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function keyedUpstream(providerId: string, env: KeyedEnv) {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const bearer = env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = bearer || env.ANTHROPIC_API_KEY;
  if (providerId === 'anthropic' || !baseUrl || !apiKey || isLoopback(baseUrl)) return undefined;
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

export async function startProviderKeyBridge(providerId: string, env: KeyedEnv): Promise<void> {
  const upstream = keyedUpstream(providerId, env);
  if (!upstream || readyBridges.has(upstream.key)) return;
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
