import { describe, test, expect } from 'bun:test';
import {
  parseArgs,
  getHelpText,
  CORS_HEADERS,
  createCorsPreflightResponse,
  shouldHaveImmutableCache,
  isHtmlFile,
  getCacheControlHeader,
  isWebSocketPath,
  createJsonErrorResponse,
  findAvailablePort,
} from '../src/cli-utils';

describe('parseArgs', () => {
  test('returns empty options for no arguments', () => {
    const result = parseArgs([]);
    expect(result.options).toEqual({});
    expect(result.error).toBeUndefined();
  });

  test('parses --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.options.help).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses -h flag', () => {
    const result = parseArgs(['-h']);
    expect(result.options.help).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses --version flag', () => {
    const result = parseArgs(['--version']);
    expect(result.options.version).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses -V flag', () => {
    const result = parseArgs(['-V']);
    expect(result.options.version).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('parses --port with valid value', () => {
    const result = parseArgs(['--port', '9283']);
    expect(result.options.port).toBe(9283);
    expect(result.error).toBeUndefined();
  });

  test('parses -p with valid value', () => {
    const result = parseArgs(['-p', '8080']);
    expect(result.options.port).toBe(8080);
    expect(result.error).toBeUndefined();
  });

  test('returns error for invalid port value', () => {
    const result = parseArgs(['--port', 'invalid']);
    expect(result.error).toBe('Invalid port value: invalid');
  });

  test('returns error for missing port value', () => {
    const result = parseArgs(['--port']);
    expect(result.error).toBe('Invalid port value: undefined');
  });

  test('parses --host with valid value', () => {
    const result = parseArgs(['--host', '127.0.0.1']);
    expect(result.options.host).toBe('127.0.0.1');
    expect(result.error).toBeUndefined();
  });

  test('returns error for missing host value', () => {
    const result = parseArgs(['--host']);
    expect(result.error).toBe('--host requires a value');
  });

  test('parses --db-path with valid path', () => {
    const result = parseArgs(['--db-path', '/path/to/db.sqlite']);
    expect(result.options.dbPath).toBe('/path/to/db.sqlite');
    expect(result.error).toBeUndefined();
  });

  test('returns error for missing db-path value', () => {
    const result = parseArgs(['--db-path']);
    expect(result.error).toBe('--db-path requires a path');
  });

  test('parses --workspace with valid path', () => {
    const result = parseArgs(['--workspace', '/path/to/workspace']);
    expect(result.options.workspaceRoot).toBe('/path/to/workspace');
    expect(result.error).toBeUndefined();
  });

  test('returns error for missing workspace value', () => {
    const result = parseArgs(['--workspace']);
    expect(result.error).toBe('--workspace requires a path');
  });

  test('returns error for unknown option', () => {
    const result = parseArgs(['--unknown']);
    expect(result.error).toBe('Unknown option: --unknown');
    expect(result.options.help).toBe(true);
  });

  test('parses multiple options together', () => {
    const result = parseArgs([
      '--port',
      '9999',
      '--host',
      'localhost',
      '--db-path',
      '/my/db.sqlite',
      '--workspace',
      '/my/workspace',
    ]);
    expect(result.options.port).toBe(9999);
    expect(result.options.host).toBe('localhost');
    expect(result.options.dbPath).toBe('/my/db.sqlite');
    expect(result.options.workspaceRoot).toBe('/my/workspace');
    expect(result.error).toBeUndefined();
  });
});

describe('getHelpText', () => {
  test('returns help text containing usage information', () => {
    const helpText = getHelpText();
    expect(helpText).toContain('HyperNeo');
    expect(helpText).toContain('Usage:');
    expect(helpText).toContain('Options:');
  });

  test('includes all documented options', () => {
    const helpText = getHelpText();
    expect(helpText).toContain('--port');
    expect(helpText).toContain('-p');
    expect(helpText).toContain('--host');
    expect(helpText).toContain('--db-path');
    expect(helpText).toContain('--workspace');
    expect(helpText).toContain('--version');
    expect(helpText).toContain('-V');
    expect(helpText).toContain('--help');
    expect(helpText).toContain('-h');
  });

  test('includes examples', () => {
    const helpText = getHelpText();
    expect(helpText).toContain('Examples:');
  });
});

describe('CORS_HEADERS', () => {
  test('contains required CORS headers', () => {
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('GET');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('POST');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(CORS_HEADERS['Access-Control-Allow-Headers']).toContain('Content-Type');
  });
});

describe('createCorsPreflightResponse', () => {
  test('creates response with null body', () => {
    const response = createCorsPreflightResponse();
    expect(response.body).toBeNull();
  });

  test('includes CORS headers', () => {
    const response = createCorsPreflightResponse();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

describe('shouldHaveImmutableCache', () => {
  test('returns true for JavaScript files', () => {
    expect(shouldHaveImmutableCache('/assets/app.js')).toBe(true);
    expect(shouldHaveImmutableCache('/bundle.min.js')).toBe(true);
  });

  test('returns true for CSS files', () => {
    expect(shouldHaveImmutableCache('/styles/main.css')).toBe(true);
  });

  test('returns true for font files', () => {
    expect(shouldHaveImmutableCache('/fonts/roboto.woff')).toBe(true);
    expect(shouldHaveImmutableCache('/fonts/roboto.woff2')).toBe(true);
    expect(shouldHaveImmutableCache('/fonts/roboto.ttf')).toBe(true);
  });

  test('returns true for image files', () => {
    expect(shouldHaveImmutableCache('/images/logo.png')).toBe(true);
    expect(shouldHaveImmutableCache('/images/hero.jpg')).toBe(true);
    expect(shouldHaveImmutableCache('/images/photo.jpeg')).toBe(true);
    expect(shouldHaveImmutableCache('/images/icon.gif')).toBe(true);
    expect(shouldHaveImmutableCache('/images/icon.svg')).toBe(true);
    expect(shouldHaveImmutableCache('/favicon.ico')).toBe(true);
  });

  test('returns false for HTML files', () => {
    expect(shouldHaveImmutableCache('/index.html')).toBe(false);
    expect(shouldHaveImmutableCache('/pages/about.html')).toBe(false);
  });

  test('returns false for other files', () => {
    expect(shouldHaveImmutableCache('/data.json')).toBe(false);
    expect(shouldHaveImmutableCache('/api/users')).toBe(false);
    expect(shouldHaveImmutableCache('/readme.txt')).toBe(false);
  });
});

describe('isHtmlFile', () => {
  test('returns true for HTML files', () => {
    expect(isHtmlFile('/index.html')).toBe(true);
    expect(isHtmlFile('/pages/about.html')).toBe(true);
    expect(isHtmlFile('test.html')).toBe(true);
  });

  test('returns false for non-HTML files', () => {
    expect(isHtmlFile('/script.js')).toBe(false);
    expect(isHtmlFile('/style.css')).toBe(false);
    expect(isHtmlFile('/htmlfile')).toBe(false);
    expect(isHtmlFile('/html')).toBe(false);
  });
});

describe('getCacheControlHeader', () => {
  test('returns immutable cache for static assets', () => {
    expect(getCacheControlHeader('/app.js')).toBe('public, max-age=31536000, immutable');
    expect(getCacheControlHeader('/style.css')).toBe('public, max-age=31536000, immutable');
    expect(getCacheControlHeader('/logo.png')).toBe('public, max-age=31536000, immutable');
  });

  test('returns no-cache for HTML files', () => {
    expect(getCacheControlHeader('/index.html')).toBe('no-cache');
  });

  test('returns default cache for other files', () => {
    expect(getCacheControlHeader('/data.json')).toBe('public, max-age=3600');
    expect(getCacheControlHeader('/api/endpoint')).toBe('public, max-age=3600');
  });
});

describe('isWebSocketPath', () => {
  test('returns true for /ws', () => {
    expect(isWebSocketPath('/ws')).toBe(true);
  });

  test('returns false for other paths', () => {
    expect(isWebSocketPath('/')).toBe(false);
    expect(isWebSocketPath('/api')).toBe(false);
    expect(isWebSocketPath('/ws/')).toBe(false);
    expect(isWebSocketPath('/websocket')).toBe(false);
  });
});

describe('createJsonErrorResponse', () => {
  test('creates 500 response by default', async () => {
    const response = createJsonErrorResponse('Something went wrong');
    expect(response.status).toBe(500);
  });

  test('creates response with custom status', async () => {
    const response = createJsonErrorResponse('Not found', 404);
    expect(response.status).toBe(404);
  });

  test('returns JSON content type', () => {
    const response = createJsonErrorResponse('Error');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  test('includes error message in body', async () => {
    const response = createJsonErrorResponse('Test error');
    const body = await response.json();
    expect(body.message).toBe('Test error');
  });

  test('includes "Internal server error" for 5xx status', async () => {
    const response = createJsonErrorResponse('Details', 500);
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
  });

  test('includes "Error" for 4xx status', async () => {
    const response = createJsonErrorResponse('Not found', 404);
    const body = await response.json();
    expect(body.error).toBe('Error');
  });
});

describe('findAvailablePort', () => {
  test('returns a valid port number', async () => {
    const port = await findAvailablePort();
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  test('returns different ports on consecutive calls', async () => {
    const port1 = await findAvailablePort();
    const port2 = await findAvailablePort();
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });

  test('returned port is actually available', async () => {
    const port = await findAvailablePort();

    const net = await import('net');
    const server = net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => {
        server.close();
        resolve();
      });
      server.on('error', reject);
    });
  });
});
