import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as net from 'net';

const hasCredentials = !!(
  process.env.ANTHROPIC_API_KEY ||
  process.env.GLM_API_KEY ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN
);

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

function waitForServerReady(
  process: ChildProcess,
  timeoutMs: number = 30000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Server startup timeout after ${timeoutMs}ms\nStdout: ${stdout}\nStderr: ${stderr}`
        )
      );
    }, timeoutMs);

    const checkReady = () => {
      const combined = stdout + stderr;
      if (
        combined.includes('Press Ctrl+C to stop') ||
        combined.includes('Production server running') ||
        combined.includes('Bun server listening')
      ) {
        clearTimeout(timeout);
        resolve({ stdout, stderr });
      }
    };

    process.stdout?.on('data', (data) => {
      stdout += data.toString();
      checkReady();
    });

    process.stderr?.on('data', (data) => {
      stderr += data.toString();
      checkReady();
    });

    process.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    process.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited with code ${code}\nStdout: ${stdout}\nStderr: ${stderr}`));
      }
    });
  });
}

describe.skipIf(!hasCredentials || !isBun)('SIGINT Shutdown Integration', () => {
  let serverProcess: ChildProcess | null = null;
  let testPort: number;
  let testWorkspace: string;

  beforeAll(async () => {
    testPort = await findAvailablePort();
    testWorkspace = `${process.env.TMPDIR || '/tmp'}/hyperneo-sigint-test-${Date.now()}`;
  });

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  });

  test(
    'should shutdown gracefully on SIGINT after server is ready',
    async () => {
      const mainPath = path.join(__dirname, '../main.ts');

      serverProcess = spawn(
        'bun',
        ['run', mainPath, '--port', testPort.toString(), '--workspace', testWorkspace],
        {
          env: {
            ...process.env,
            NODE_ENV: 'test',
          },
          stdio: 'pipe',
        }
      );

      console.log(`[TEST] Waiting for server to start on port ${testPort}...`);
      const { stdout: startupStdout } = await waitForServerReady(serverProcess);
      console.log(`[TEST] Server is ready. Startup output:\n${startupStdout.slice(0, 500)}`);

      const shutdownStart = Date.now();

      console.log(`[TEST] Sending SIGINT to server PID ${serverProcess.pid}...`);
      const killResult = serverProcess.kill('SIGINT');
      expect(killResult).toBe(true);

      const exitPromise = new Promise<{ code: number | null; shutdownOutput: string }>(
        (resolve, reject) => {
          let shutdownOutput = '';
          const timeout = setTimeout(() => {
            reject(
              new Error(`Server did not exit within 15s after SIGINT\nOutput: ${shutdownOutput}`)
            );
          }, 15000);

          serverProcess!.stdout?.on('data', (data) => {
            shutdownOutput += data.toString();
          });
          serverProcess!.stderr?.on('data', (data) => {
            shutdownOutput += data.toString();
          });

          serverProcess!.on('exit', (code) => {
            clearTimeout(timeout);
            resolve({ code, shutdownOutput });
          });
        }
      );

      const { code, shutdownOutput } = await exitPromise;
      const shutdownDuration = Date.now() - shutdownStart;

      console.log(`[TEST] Server exited with code ${code} after ${shutdownDuration}ms`);
      console.log(`[TEST] Shutdown output:\n${shutdownOutput.slice(-1000)}`);

      expect(code).toBe(0);
      expect(shutdownDuration).toBeLessThan(10000);
      expect(shutdownOutput).toContain('Stopping server');
      expect(shutdownOutput).toContain('Graceful shutdown complete');

      serverProcess = null;
    },
    { timeout: 60000 }
  );

  test(
    'should handle rapid consecutive SIGINT signals',
    async () => {
      const mainPath = path.join(__dirname, '../main.ts');

      serverProcess = spawn(
        'bun',
        ['run', mainPath, '--port', (testPort + 1).toString(), '--workspace', testWorkspace + '-2'],
        {
          env: {
            ...process.env,
            NODE_ENV: 'test',
          },
          stdio: 'pipe',
        }
      );

      console.log(`[TEST] Waiting for server to start...`);
      await waitForServerReady(serverProcess);
      console.log(`[TEST] Server is ready.`);

      console.log(`[TEST] Sending first SIGINT...`);
      serverProcess.kill('SIGINT');

      console.log(`[TEST] Sending second SIGINT immediately...`);
      serverProcess.kill('SIGINT');

      const exitPromise = new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          let output = '';
          const timeout = setTimeout(() => {
            reject(new Error(`Server did not exit within 10s after double SIGINT`));
          }, 10000);

          serverProcess!.stdout?.on('data', (data) => {
            output += data.toString();
          });
          serverProcess!.stderr?.on('data', (data) => {
            output += data.toString();
          });

          serverProcess!.on('exit', (code) => {
            clearTimeout(timeout);
            resolve({ code, output });
          });
        }
      );

      const { code, output } = await exitPromise;
      console.log(`[TEST] Server exited with code ${code}`);
      console.log(`[TEST] Output:\n${output.slice(-500)}`);

      expect(code === 0 || code === 1).toBe(true);

      serverProcess = null;
    },
    { timeout: 60000 }
  );
});

describe.skipIf(hasCredentials && isBun)('SIGINT Shutdown Integration (skipped)', () => {
  test('requires Bun runtime + API credentials (ANTHROPIC_API_KEY, GLM_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN)', () => {
    console.log('Skipping SIGINT integration tests - no API credentials available');
    expect(true).toBe(true);
  });
});
