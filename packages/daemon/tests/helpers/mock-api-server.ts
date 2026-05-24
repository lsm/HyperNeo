/**
 * Mock API Server Test Helper
 *
 * Creates a local HTTP server that mocks the Anthropic API responses.
 * This is simpler than using Dev Proxy because we just set ANTHROPIC_BASE_URL
 * to point to this server, avoiding all the proxy environment variable issues.
 *
 * ## Usage
 *
 * ```ts
 * import { createMockApiServer, type MockApiServer } from './mock-api-server';
 *
 * describe('My API tests', () => {
 *   let server: MockApiServer;
 *
 *   beforeEach(async () => {
 *     server = await createMockApiServer();
 *     await server.start();
 *   });
 *
 *   afterEach(async () => {
 *     await server.stop();
 *   });
 *
 *   it('should mock API response', async () => {
 *     // server automatically sets ANTHROPIC_BASE_URL
 *     // ... test code
 *   });
 * });
 * ```
 *
 * ## Environment Variables
 *
 * The helper automatically sets:
 * - ANTHROPIC_BASE_URL: Points to the mock server
 * - Stores original value for restoration
 */

import { serve } from 'bun';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

/**
 * Configuration options for the mock API server
 */
export interface MockApiServerOptions {
  /**
   * Port to run the server on
   * Default: 8000
   */
  port?: number;

  /**
   * Path to the directory containing mock response files
   * Default: <repo-root>/.devproxy/
   */
  mockDir?: string;

  /**
   * Log level
   * Default: 'warning'
   */
  logLevel?: 'debug' | 'info' | 'warning' | 'error';
}

/**
 * Controller interface for managing the mock API server
 */
export interface MockApiServer {
  /**
   * Start the mock API server
   */
  start(): Promise<void>;

  /**
   * Stop the mock API server
   */
  stop(): Promise<void>;

  /**
   * Check if the server is currently running
   */
  isRunning(): boolean;

  /**
   * Get the server URL (e.g., http://127.0.0.1:8000)
   */
  readonly serverUrl: string;

  /**
   * Get the server port
   */
  readonly port: number;

  /**
   * Restore original environment variables
   */
  restoreEnv(): void;
}

/**
 * Standard Anthropic API mock response
 */
const DEFAULT_MOCK_RESPONSE = {
  id: 'msg_mock123',
  type: 'message',
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: '[MOCKED BY TEST SERVER] This is a mocked response for testing purposes.',
    },
  ],
  model: 'claude-sonnet-4-20250514',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    service_tier: 'standard',
  },
};

/**
 * Find the repository root directory by looking for package.json with workspaces
 */
function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = require(pkgPath);
      if (pkg.workspaces) {
        return dir;
      }
    } catch {
      // Continue searching
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Check if mock API server is available (Bun has built-in HTTP server)
 */
async function isMockApiServerAvailable(): Promise<boolean> {
  // Bun has built-in serve() function
  return typeof serve === 'function';
}

/**
 * Read mock response from a JSON file
 */
async function readMockResponse(mockDir: string, requestBody: any): Promise<any> {
  try {
    // Try to find a matching mock file based on the request
    // For now, use a simple approach - check for basic patterns
    const userMessage = requestBody?.messages?.[0]?.content?.toLowerCase() || '';

    let mockFile = 'mocks.json'; // Default

    // Check for specific patterns
    if (userMessage.includes('what is') && userMessage.includes('+')) {
      // Math question - try to extract the answer
      const match = userMessage.match(/what is\s+(\d+)\s*\+\s*(\d+)/i);
      if (match) {
        const result = parseInt(match[1]) + parseInt(match[2]);
        return {
          ...DEFAULT_MOCK_RESPONSE,
          content: [{ type: 'text', text: String(result) }],
          usage: { ...DEFAULT_MOCK_RESPONSE.usage, output_tokens: 5 },
        };
      }
    }

    if (userMessage.includes('hello') || userMessage.includes('hi')) {
      return {
        ...DEFAULT_MOCK_RESPONSE,
        content: [{ type: 'text', text: 'Hello! How can I help you today?' }],
      };
    }

    if (userMessage.includes('done') || userMessage.includes('finished')) {
      return {
        ...DEFAULT_MOCK_RESPONSE,
        content: [{ type: 'text', text: 'Done!' }],
      };
    }

    // Try to read from mock file
    const mockFilePath = path.join(mockDir, mockFile);
    const mockContent = await readFile(mockFilePath, 'utf-8');
    const mockData = JSON.parse(mockContent);

    // Return the first mock response
    if (mockData.mocks && mockData.mocks.length > 0) {
      return mockData.mocks[0].response.body;
    }

    return DEFAULT_MOCK_RESPONSE;
  } catch {
    return DEFAULT_MOCK_RESPONSE;
  }
}

/**
 * Create a mock API server instance
 */
export async function createMockApiServer(
  options: MockApiServerOptions = {}
): Promise<MockApiServer> {
  const { port = 8000, mockDir: userMockDir, logLevel = 'warning' } = options;

  // Check if Bun's serve is available
  if (!(await isMockApiServerAvailable())) {
    throw new Error('Mock API server requires Bun runtime (serve function not available)');
  }

  // Resolve paths
  const repoRoot = findRepoRoot(__dirname);
  if (!repoRoot) {
    throw new Error('Could not find repository root directory');
  }

  const finalMockDir = userMockDir || path.join(repoRoot, '.devproxy');

  // State
  let server: ReturnType<typeof serve> | null = null;
  let originalEnv: Record<string, string | undefined> = {};
  let originalBaseUrl: string | undefined;

  // Logger
  const log = {
    debug: (...args: any[]) => {
      if (logLevel === 'debug') console.log('[MOCK API]', ...args);
    },
    info: (...args: any[]) => {
      if (logLevel === 'debug' || logLevel === 'info') console.log('[MOCK API]', ...args);
    },
    warning: (...args: any[]) => {
      if (logLevel !== 'error') console.log('[MOCK API]', ...args);
    },
    error: (...args: any[]) => {
      console.log('[MOCK API ERROR]', ...args);
    },
  };

  const controller: MockApiServer = {
    get serverUrl() {
      return `http://127.0.0.1:${port}`;
    },

    get port() {
      return port;
    },

    isRunning() {
      return server !== null;
    },

    async start() {
      if (server) {
        throw new Error('Mock API server is already running');
      }

      // Save original ANTHROPIC_BASE_URL
      originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
      originalEnv.ANTHROPIC_BASE_URL = originalBaseUrl;

      // Set ANTHROPIC_BASE_URL to point to our mock server
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

      log.info(`Starting mock API server on port ${port}`);
      log.info(`ANTHROPIC_BASE_URL set to: ${process.env.ANTHROPIC_BASE_URL}`);

      // Start the server
      server = serve({
        port,
        async fetch(req) {
          const url = new URL(req.url);

          log.debug(`${req.method} ${url.pathname}`);

          // Handle Anthropic API messages endpoint
          if (url.pathname === '/v1/messages' && req.method === 'POST') {
            try {
              const requestBody = await req.json();
              log.debug('Request body:', requestBody);

              // Read mock response
              const mockResponse = await readMockResponse(finalMockDir, requestBody);

              log.info('Returning mock response for /v1/messages');

              return new Response(JSON.stringify(mockResponse), {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'anthropic-ratelimit-requests-limit': '50',
                  'anthropic-ratelimit-requests-remaining': '49',
                },
              });
            } catch (error) {
              log.error('Error parsing request:', error);
              return new Response(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'internal_error',
                    message: 'Failed to parse request',
                  },
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
              );
            }
          }

          // Return 404 for other paths
          return new Response('Not Found', { status: 404 });
        },
      });

      // Wait a bit for server to be ready
      await new Promise((resolve) => setTimeout(resolve, 100));

      log.info('Mock API server started');
    },

    async stop() {
      if (!server) {
        return;
      }

      log.info('Stopping mock API server');

      // Stop the server
      server = null;

      // Restore original ANTHROPIC_BASE_URL
      if (originalBaseUrl !== undefined) {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      } else {
        delete process.env.ANTHROPIC_BASE_URL;
      }

      log.info('Mock API server stopped');
    },

    restoreEnv() {
      if (originalBaseUrl !== undefined) {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
      } else {
        delete process.env.ANTHROPIC_BASE_URL;
      }
      originalEnv = {};
    },
  };

  return controller;
}

/**
 * Global mock API server controller for shared use across tests
 */
let globalController: MockApiServer | null = null;

/**
 * Start a global mock API server instance
 */
export async function startGlobalMockApiServer(
  options?: MockApiServerOptions
): Promise<MockApiServer> {
  if (globalController) {
    return globalController;
  }
  globalController = await createMockApiServer(options);
  await globalController.start();
  return globalController;
}

/**
 * Stop the global mock API server instance
 */
export async function stopGlobalMockApiServer(): Promise<void> {
  if (globalController) {
    await globalController.stop();
    globalController.restoreEnv();
    globalController = null;
  }
}

/**
 * Get the global mock API server controller (if started)
 */
export function getGlobalMockApiServer(): MockApiServer | null {
  return globalController;
}
