import { readFileSync } from 'node:fs';
import path from 'node:path';

interface MockHeader {
  name?: string;
  value?: unknown;
}

interface MockResponseSpec {
  statusCode?: number;
  headers?: MockHeader[];
  body?: unknown;
}

interface MockRequestSpec {
  url?: string;
  method?: string;
  bodyFragment?: unknown;
}

interface MockEntry {
  request?: MockRequestSpec;
  response?: MockResponseSpec;
}

interface ParsedArgs {
  port: number;
  apiPort: number;
  configFilePath?: string;
  mocksFilePath?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let port = 8000;
  let apiPort: number | undefined;
  let configFilePath: string | undefined;
  let mocksFilePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      port = Number(argv[++i]);
    } else if (arg === '--api-port') {
      apiPort = Number(argv[++i]);
    } else if (arg === '--config-file') {
      configFilePath = argv[++i];
    } else if (arg === '--mocks-file') {
      mocksFilePath = argv[++i];
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid --port value: ${port}`);
  }
  if (apiPort === undefined) {
    apiPort = 8897 + (port - 8000);
  }
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    fail(`invalid --api-port value: ${apiPort}`);
  }

  return { port, apiPort, configFilePath, mocksFilePath };
}

function fail(message: string): never {
  console.error(`[dev-proxy-stub] ${message}`);
  process.exit(1);
}

function loadMocks(configFilePath: string | undefined, mocksFilePath: string | undefined) {
  const configPath = path.resolve(configFilePath ?? path.join('.devproxy', 'devproxyrc.json'));
  let config: { mockResponsePlugin?: { mocksFile?: string } } | undefined;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    fail(`cannot read config file ${configPath}: ${String(error)}`);
  }

  const mocksFile = config?.mockResponsePlugin?.mocksFile ?? 'mocks.json';
  const mocksPath = mocksFilePath
    ? path.resolve(mocksFilePath)
    : path.resolve(path.dirname(configPath), mocksFile);

  let mocks: MockEntry[];
  try {
    const parsed = JSON.parse(readFileSync(mocksPath, 'utf-8')) as { mocks?: MockEntry[] };
    mocks = Array.isArray(parsed.mocks) ? parsed.mocks : [];
  } catch (error) {
    fail(`cannot read mocks file ${mocksPath}: ${String(error)}`);
  }

  return { configPath, mocksPath, mocks };
}

const wildcardCache = new Map<string, RegExp>();

function wildcardToRegex(pattern: string): RegExp {
  let regex = wildcardCache.get(pattern);
  if (!regex) {
    const source = `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`;
    regex = new RegExp(source);
    wildcardCache.set(pattern, regex);
  }
  return regex;
}

function deepIncludes(body: unknown, fragment: unknown): boolean {
  if (fragment === null || typeof fragment !== 'object') {
    return body === fragment;
  }
  if (Array.isArray(fragment)) {
    return (
      Array.isArray(body) &&
      body.length === fragment.length &&
      fragment.every((item, index) => deepIncludes(body[index], item))
    );
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  return Object.entries(fragment).every(
    ([key, value]) =>
      key in (body as Record<string, unknown>) &&
      deepIncludes((body as Record<string, unknown>)[key], value)
  );
}

function bodyMatches(fragment: unknown, method: string, bodyText: string): boolean {
  if (method === 'GET') {
    return true;
  }
  if (fragment === undefined || fragment === null) {
    return true;
  }
  if (bodyText.length === 0) {
    return false;
  }
  if (typeof fragment === 'string') {
    return bodyText.toLowerCase().includes(fragment.toLowerCase());
  }
  try {
    return deepIncludes(JSON.parse(bodyText), fragment);
  } catch {
    return false;
  }
}

function findMock(
  mocks: MockEntry[],
  method: string,
  url: string,
  bodyText: string
): MockEntry | null {
  for (const mock of mocks) {
    const request = mock.request;
    if (!request || typeof request.url !== 'string' || request.url.length === 0) {
      continue;
    }
    if ((request.method ?? 'GET') !== method) {
      continue;
    }
    const urlMatches =
      request.url === url || (request.url.includes('*') && wildcardToRegex(request.url).test(url));
    if (!urlMatches) {
      continue;
    }
    if (!bodyMatches(request.bodyFragment, method, bodyText)) {
      continue;
    }
    return mock;
  }
  return null;
}

function buildResponse(mock: MockEntry): Response {
  const spec = mock.response ?? {};
  const status = typeof spec.statusCode === 'number' ? spec.statusCode : 200;
  const headers = new Headers();
  for (const header of spec.headers ?? []) {
    if (header && typeof header.name === 'string') {
      headers.set(header.name, header.value === undefined ? '' : String(header.value));
    }
  }
  let body: string | undefined;
  if (spec.body !== null && spec.body !== undefined) {
    body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body, null, 2);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }
  return new Response(body, { status, headers });
}

function unmockedResponse(method: string, url: string): Response {
  return new Response(
    JSON.stringify(
      { error: { code: 'Bad Gateway', message: `No mock response found for ${method} ${url}` } },
      null,
      2
    ),
    {
      status: 502,
      headers: { 'content-type': 'application/json' },
    }
  );
}

const args = parseArgs(process.argv.slice(2));
const { configPath, mocksPath, mocks } = loadMocks(args.configFilePath, args.mocksFilePath);

try {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: args.port,
    fetch: async (request) => {
      const method = request.method.toUpperCase();
      const url = request.url;
      const bodyText = method === 'GET' ? '' : await request.text();
      const mock = findMock(mocks, method, url, bodyText);
      if (!mock) {
        console.error(`[dev-proxy-stub] no mock matched ${method} ${url}`);
        return unmockedResponse(method, url);
      }
      return buildResponse(mock);
    },
  });

  const apiServer = Bun.serve({
    hostname: '127.0.0.1',
    port: args.apiPort,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/proxy') {
        return Response.json({ recording: true, configFile: configPath });
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(
    `[dev-proxy-stub] listening on http://127.0.0.1:${server.port} (api http://127.0.0.1:${apiServer.port})`
  );
  console.log(`[dev-proxy-stub] config: ${configPath}`);
  console.log(`[dev-proxy-stub] mocks: ${mocksPath} (${mocks.length} mocks)`);
} catch (error) {
  fail(`failed to start: ${String(error)}`);
}
