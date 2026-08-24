import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';
import type { AuthManager } from '../auth-manager.ts';
import type { Config } from '../../config.ts';
import type { HealthStatus, DaemonConfig } from '@hyperneo/shared';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

function getSDKVersion(): string {
  try {
    const sdkModulePath = import.meta.resolve?.(SDK_PACKAGE);
    if (sdkModulePath) {
      const sdkPath = sdkModulePath.startsWith('file://')
        ? fileURLToPath(sdkModulePath)
        : sdkModulePath;
      const pkgJson = JSON.parse(readFileSync(join(dirname(sdkPath), 'package.json'), 'utf-8')) as {
        version?: unknown;
      };
      if (typeof pkgJson.version === 'string') {
        return pkgJson.version;
      }
    }
  } catch {}

  try {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      try {
        const pkgPath = join(currentDir, 'node_modules', SDK_PACKAGE, 'package.json');
        const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
        if (typeof pkgJson.version === 'string') {
          return pkgJson.version;
        }
      } catch {}
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {}

  return 'unknown';
}

const VERSION = '0.1.1';
const CLAUDE_SDK_VERSION = getSDKVersion();
const startTime = Date.now();

export function setupSystemHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  authManager: AuthManager,
  config: Config
): void {
  messageHub.onRequest('system.health', async () => {
    const response: HealthStatus = {
      status: 'ok',
      version: VERSION,
      uptime: Date.now() - startTime,
      sessions: {
        active: sessionManager.getActiveSessions(),
        total: sessionManager.getTotalSessions(),
      },
    };

    return response;
  });

  messageHub.onRequest('system.config', async () => {
    const authStatus = await authManager.getAuthStatus();

    const response: DaemonConfig = {
      version: VERSION,
      claudeSDKVersion: CLAUDE_SDK_VERSION,
      defaultModel: config.defaultModel,
      maxSessions: config.maxSessions,
      storageLocation: config.dbPath,
      authMethod: authStatus.method,
      authStatus,
    };

    return response;
  });

  messageHub.onRequest('test.echo', async (data: { message: string }) => {
    const echoMessage = data.message || 'echo';

    messageHub.event('test.echo', { echo: echoMessage }, { channel: 'global' });

    return { echoed: echoMessage };
  });
}
