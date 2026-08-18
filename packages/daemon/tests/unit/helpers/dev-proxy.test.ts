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

async function isDevProxyInstalled(): Promise<boolean> {
  try {
    const result = spawnSync('which', ['devproxy'], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function isDevProxyAlreadyRunning(): Promise<boolean> {
  try {
    const result = spawnSync('pgrep', ['-x', 'devproxy'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const DEV_PROXY_INSTALLED = await isDevProxyInstalled();
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
    const itif = (name: string, fn: () => Promise<unknown>, opts?: { timeout?: number }): void => {
      if (DEV_PROXY_FREE_TO_START) {
        it(name, fn, opts?.timeout);
      } else {
        it.skip(name, fn);
      }
    };

    itif(
      'should start and stop proxy',
      async () => {
        const controller = createDevProxyController({
          port: 8100 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });

        try {
          await controller.start();
          expect(controller.isRunning()).toBe(true);
          expect(controller.pid).toBeUndefined();

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
        const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

        const controller = createDevProxyController({
          port: 8200 + Math.floor(Math.random() * 100),
          logLevel: 'error',
        });

        try {
          await controller.start();
          expect(process.env.ANTHROPIC_BASE_URL).toBe(controller.proxyUrl);

          controller.restoreEnv();

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
    const itif = (name: string, fn: () => Promise<unknown>, opts?: { timeout?: number }): void => {
      if (DEV_PROXY_FREE_TO_START) {
        it(name, fn, opts?.timeout);
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
        if (controller.isRunning()) {
          await controller.stop();
        }
        controller.restoreEnv();
        if (originalBaseUrl === undefined) {
          delete process.env.ANTHROPIC_BASE_URL;
        } else {
          process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
        }
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

        expect(controller.isRunning()).toBe(false);
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
        controller = createDevProxyController({ port: tcpPort, setEnvVars: true });

        await controller.start();

        expect(controller.isExternal).toBe(true);
        expect(process.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${tcpPort}`);
      });

      it('can be restarted after stopping an external proxy', async () => {
        await controller.start();
        expect(controller.isExternal).toBe(true);
        await controller.stop();

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
      if (DEV_PROXY_INSTALLED) {
        return;
      }

      const controller = createDevProxyController();
      await expect(controller.start()).rejects.toThrow('devproxy is not installed');
    });
  });
});
