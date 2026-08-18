import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

export interface MockApiServerOptions {
  port?: number;

  mockDir?: string;

  logLevel?: 'debug' | 'info' | 'warning' | 'error';
}

export interface MockApiServer {
  start(): Promise<void>;

  stop(): Promise<void>;

  isRunning(): boolean;

  readonly serverUrl: string;

  readonly port: number;

  restoreEnv(): void;
}

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

async function isMockApiServerAvailable(): Promise<boolean> {
  return true;
}

async function readMockResponse(mockDir: string, requestBody: any): Promise<any> {
  try {
    const userMessage = requestBody?.messages?.[0]?.content?.toLowerCase() || '';

    let mockFile = 'mocks.json';

    if (userMessage.includes('what is') && userMessage.includes('+')) {
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

    const mockFilePath = path.join(mockDir, mockFile);
    const mockContent = await readFile(mockFilePath, 'utf-8');
    const mockData = JSON.parse(mockContent);

    if (mockData.mocks && mockData.mocks.length > 0) {
      return mockData.mocks[0].response.body;
    }

    return DEFAULT_MOCK_RESPONSE;
  } catch {
    return DEFAULT_MOCK_RESPONSE;
  }
}

export async function createMockApiServer(
  options: MockApiServerOptions = {}
): Promise<MockApiServer> {
  const { port = 8000, mockDir: userMockDir, logLevel = 'warning' } = options;

  if (!(await isMockApiServerAvailable())) {
    throw new Error('Mock API server requires Bun runtime (serve function not available)');
  }

  const repoRoot = findRepoRoot(__dirname);
  if (!repoRoot) {
    throw new Error('Could not find repository root directory');
  }

  const finalMockDir = userMockDir || path.join(repoRoot, '.devproxy');

  let server: HttpServer | null = null;
  let originalEnv: Record<string, string | undefined> = {};
  let originalBaseUrl: string | undefined;

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

      originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
      originalEnv.ANTHROPIC_BASE_URL = originalBaseUrl;

      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

      log.info(`Starting mock API server on port ${port}`);
      log.info(`ANTHROPIC_BASE_URL set to: ${process.env.ANTHROPIC_BASE_URL}`);

      const fetchHandler = async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        log.debug(`${req.method} ${url.pathname}`);

        if (url.pathname === '/v1/messages' && req.method === 'POST') {
          try {
            const requestBody = await req.json();
            log.debug('Request body:', requestBody);

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

        return new Response('Not Found', { status: 404 });
      };

      server = createServer(async (incoming: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);
        const url = `http://127.0.0.1:${port}${incoming.url ?? '/'}`;
        const request = new Request(url, {
          method: incoming.method,
          headers: Object.entries(incoming.headers).reduce<Record<string, string>>(
            (acc, [k, v]) => {
              if (v !== undefined) acc[k] = Array.isArray(v) ? v.join(', ') : v;
              return acc;
            },
            {}
          ),
          body: body.length > 0 ? body : null,
        });
        const response = await fetchHandler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(await response.text());
      });
      server.listen(port, '127.0.0.1');

      await new Promise((resolve) => setTimeout(resolve, 100));

      log.info('Mock API server started');
    },

    async stop() {
      if (!server) {
        return;
      }

      log.info('Stopping mock API server');

      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;

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

let globalController: MockApiServer | null = null;

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

export async function stopGlobalMockApiServer(): Promise<void> {
  if (globalController) {
    await globalController.stop();
    globalController.restoreEnv();
    globalController = null;
  }
}

export function getGlobalMockApiServer(): MockApiServer | null {
  return globalController;
}
