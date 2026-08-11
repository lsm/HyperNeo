/**
 * Unit tests for Dev Proxy helper module
 *
 * Note: Most tests skip when devproxy is not installed since
 * the helper requires the actual devproxy binary to run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { spawnSync } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import {
  createDevProxyController,
  startGlobalDevProxy,
  stopGlobalDevProxy,
  getGlobalDevProxy,
  type DevProxyOptions,
} from '../../helpers/dev-proxy';

/**
 * Bind a TCP server on a random available port and return the server + port.
 * Used to simulate an already-running proxy process in tests.
 */
async function bindTcpServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

async function closeTcpServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// Check if devproxy is available
async function isDevProxyInstalled(): Promise<boolean> {
  try {
    const result = spawnSync('which', ['devproxy'], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Returns true if a devproxy process is already running on this machine.
 * devproxy enforces a single-instance constraint regardless of port, so when
 * it is already running, tests that need to start a fresh instance must skip.
 */
async function isDevProxyAlreadyRunning(): Promise<boolean> {
  try {
    // pgrep -x matches the exact process name (macOS / Linux)
    const result = spawnSync('pgrep', ['-x', 'devproxy'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const DEV_PROXY_INSTALLED = await isDevProxyInstalled();
// Tests that need to start a fresh devproxy instance must skip when one is already running
// because devproxy enforces a single-instance constraint (any port).
const DEV_PROXY_FREE_TO_START = DEV_PROXY_INSTALLED && !(await isDevProxyAlreadyRunning());

describe('Dev Proxy Helper', () => {
  describe('createDevProxyController', () => {
    it('should create controller with default options', () => {
      const controller = createDevProxyController();
      expect(controller).toBeDefined();
      expect(controller.port).toBe(8000);
      expect(controller.proxyUrl).toBe('http://127.0.0.1:8000');
      expect(controller.isRunning()).toBe(false);
      expect(controller.isExternal).toBe(false);
      expect(controller.pid).toBeUndefined();
    });

    it('should create controller with custom port', () => {
      const controller = createDevProxyController({ port: 9000 });
      expect(controller.port).toBe(9000);
      expect(controller.proxyUrl).toBe('http://127.0.0.1:9000');
    });

    it('should throw when loading non-existent mock file', () => {
      const controller = createDevProxyController();
      expect(() => controller.loadMockFile('/non/existent/file.json')).toThrow(
        'Mock file not found'
      );
    });

    it('should not be running initially', () => {
      const controller = createDevProxyController();
      expect(controller.isRunning()).toBe(false);
    });
  });

  describe('start/stop lifecycle', () => {
    // Skip when devproxy is not installed or when an instance is already running.
    // devproxy enforces a single-instance constraint so a second start attempt
    // on any port will fail when the binary is already in use.
    // Conditional runner: execute when a fresh devproxy can start, skip
    // otherwise. Normalizes bun:test's `(name, fn, { timeout })` form to
    // Vitest 4's `(name, timeout, fn)`. The bun:test shim only reorders the
    // proxied `it`, NOT `it.skip`, so a bare ternary makes `it.skip(name, fn,
    // { timeout })` throw under Vitest 4 whenever devproxy is absent (CI) and
    // every case here is skipped.
    const itif = (name: string, fn: () => Promise<unknown>, opts?: { timeout?: number }): void => {
      if (DEV_PROXY_FREE_TO_START) {
        if (opts?.timeout) {
          it(name, opts.timeout, fn);
        } else {
          it(name, fn);
        }
      } else {
        it.skip(name, fn);
      }
    };

    itif(
      'should start and stop proxy',
      async () => {
        const controller = createDevProxyController({
          port: 8100 + Math.floor(Math.random() * 100),
          logLevel: 'error', // Reduce log noise in tests
        });

        try {
          await controller.start();
          expect(controller.isRunning()).toBe(true);
          // Detached devproxy process doesn't expose a stable PID in this helper.
          expect(controller.pid).toBeUndefined();

          // Verify ANTHROPIC_BASE_URL is redirected to the local proxy
          expect(process.env.ANTHROPIC_BASE_URL).toBe(controller.proxyUrl);
        } finally {
          await controller.stop();
          expect(controller.isRunning()).toBe(false);
        }
      },
      { timeout: 15000 }
    );

    itif(
      'should restore environment variables after stop',
      async () => {
        // Save original values
        const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

        const controller = createDevProxyController({
          port: 8200 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });

        try {
          await controller.start();
          expect(process.env.ANTHROPIC_BASE_URL).toBe(controller.proxyUrl);

          controller.restoreEnv();

          // Should restore to original values
          expect(process.env.ANTHROPIC_BASE_URL).toBe(originalAnthropicBaseUrl);
        } finally {
          await controller.stop();
        }
      },
      { timeout: 15000 }
    );

    itif(
      'should throw error when starting twice',
      async () => {
        const controller = createDevProxyController({
          port: 8300 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });

        try {
          await controller.start();
          await expect(controller.start()).rejects.toThrow('already running');
        } finally {
          await controller.stop();
        }
      },
      { timeout: 15000 }
    );

    itif(
      'should handle stop when not started',
      async () => {
        const controller = createDevProxyController();
        // Should not throw
        await controller.stop();
      },
      { timeout: 5000 }
    );

    itif(
      'should wait for proxy to be ready',
      async () => {
        const controller = createDevProxyController({
          port: 8400 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });

        try {
          await controller.start();
          await expect(controller.waitForReady(5000)).resolves.toBeUndefined();
        } finally {
          await controller.stop();
        }
      },
      { timeout: 15000 }
    );
  });

  describe('Global Dev Proxy', () => {
    // Conditional runner: execute when a fresh devproxy can start, skip
    // otherwise. Normalizes bun:test's `(name, fn, { timeout })` form to
    // Vitest 4's `(name, timeout, fn)`. The bun:test shim only reorders the
    // proxied `it`, NOT `it.skip`, so a bare ternary makes `it.skip(name, fn,
    // { timeout })` throw under Vitest 4 whenever devproxy is absent (CI) and
    // every case here is skipped.
    const itif = (name: string, fn: () => Promise<unknown>, opts?: { timeout?: number }): void => {
      if (DEV_PROXY_FREE_TO_START) {
        if (opts?.timeout) {
          it(name, opts.timeout, fn);
        } else {
          it(name, fn);
        }
      } else {
        it.skip(name, fn);
      }
    };

    afterEach(async () => {
      await stopGlobalDevProxy();
    });

    itif(
      'should start and stop global proxy',
      async () => {
        const controller = await startGlobalDevProxy({
          port: 8500 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });

        expect(controller).toBeDefined();
        expect(controller.isRunning()).toBe(true);
        expect(getGlobalDevProxy()).toBe(controller);

        await stopGlobalDevProxy();
        expect(getGlobalDevProxy()).toBeNull();
      },
      { timeout: 15000 }
    );

    itif(
      'should return same controller on multiple start calls',
      async () => {
        const controller1 = await startGlobalDevProxy({
          port: 8600 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });
        const controller2 = await startGlobalDevProxy();

        expect(controller1).toBe(controller2);
      },
      { timeout: 15000 }
    );
  });

  describe('isExternal — reuse existing proxy', () => {
    it('isExternal is false on a fresh controller', () => {
      const controller = createDevProxyController();
      expect(controller.isExternal).toBe(false);
    });

    // All tests below need a live TCP server to simulate a pre-existing proxy.
    // A shared server + controller are set up in beforeEach and torn down in
    // afterEach so the framework guarantees cleanup even when assertions throw.
    describe('with a simulated pre-existing proxy', () => {
      let tcpServer: net.Server;
      let tcpPort: number;
      let controller: ReturnType<typeof createDevProxyController>;
      let originalBaseUrl: string | undefined;

      beforeEach(async () => {
        const bound = await bindTcpServer();
        tcpServer = bound.server;
        tcpPort = bound.port;
        controller = createDevProxyController({ port: tcpPort, setEnvVars: false });
        originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
      });

      afterEach(async () => {
        // Stop controller first (no-op for external, but keeps state consistent).
        if (controller.isRunning()) {
          await controller.stop();
        }
        controller.restoreEnv();
        // Restore env regardless of what each test did.
        if (originalBaseUrl === undefined) {
          delete process.env.ANTHROPIC_BASE_URL;
        } else {
          process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
        }
        // Close the TCP server last so the controller stop() check above
        // (which probes the port) still sees it open.
        await closeTcpServer(tcpServer);
      });

      it('adopts an existing proxy on the port without starting a new process', async () => {
        await controller.start();

        expect(controller.isRunning()).toBe(true);
        expect(controller.isExternal).toBe(true);
      });

      it('stop() does not close the external proxy port', async () => {
        await controller.start();
        expect(controller.isRunning()).toBe(true);
        expect(controller.isExternal).toBe(true);

        await controller.stop();

        // Controller should report not running after stop
        expect(controller.isRunning()).toBe(false);
        // The TCP server (external proxy) must still be accepting connections
        await expect(
          new Promise<void>((resolve, reject) => {
            const socket = net.createConnection({ port: tcpPort, host: '127.0.0.1' });
            socket.once('connect', () => {
              socket.destroy();
              resolve();
            });
            socket.once('error', reject);
          })
        ).resolves.toBeUndefined();
      });

      it('isExternal resets to false after stop()', async () => {
        await controller.start();
        expect(controller.isExternal).toBe(true);

        await controller.stop();
        expect(controller.isExternal).toBe(false);
      });

      it('sets env vars when setEnvVars=true and adopting external proxy', async () => {
        // Re-create controller with setEnvVars=true for this specific test.
        controller = createDevProxyController({ port: tcpPort, setEnvVars: true });

        await controller.start();

        expect(controller.isExternal).toBe(true);
        expect(process.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${tcpPort}`);
        // afterEach will call restoreEnv() and reset ANTHROPIC_BASE_URL.
      });

      it('can be restarted after stopping an external proxy', async () => {
        // First adoption
        await controller.start();
        expect(controller.isExternal).toBe(true);
        await controller.stop();

        // Second adoption (same external server still running)
        await controller.start();
        expect(controller.isExternal).toBe(true);
        expect(controller.isRunning()).toBe(true);
      });
    });
  });

  describe('loadMockFile', () => {
    it('should throw for non-existent mock file', () => {
      const controller = createDevProxyController();
      expect(() => controller.loadMockFile('/path/to/nonexistent.json')).toThrow(
        'Mock file not found'
      );
    });
  });

  describe('when devproxy is not installed', () => {
    it('should throw error on start if not installed', async () => {
      // Only meaningful when devproxy is not installed and no process is running
      if (DEV_PROXY_INSTALLED) {
        // Can't test this path when devproxy IS installed
        return;
      }

      const controller = createDevProxyController();
      await expect(controller.start()).rejects.toThrow('devproxy is not installed');
    });
  });
});
