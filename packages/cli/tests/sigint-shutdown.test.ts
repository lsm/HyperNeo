/**
 * SIGINT Shutdown Integration Tests
 *
 * These tests verify that Ctrl+C (SIGINT) properly shuts down the CLI server.
 * Tests spawn a real CLI server process and send signals to verify behavior.
 *
 * Requirements:
 * - ANTHROPIC_API_KEY or GLM_API_KEY must be set for server to start
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as net from 'net';

// Check if we have valid API credentials
const hasCredentials = !!(
  process.env.ANTHROPIC_API_KEY ||
  process.env.GLM_API_KEY ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN
);

/**
 * Find an available port
 */
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

/**
 * Wait for server to be ready by checking for the ready message
 */
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
      // Check for either success or error conditions
      // Production/test server logs "Production server running!" or "Bun server listening"
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

describe.skipIf(!hasCredentials)('SIGINT Shutdown Integration', () => {
  let serverProcess: ChildProcess | null = null;
  let testPort: number;
  let testWorkspace: string;

  beforeAll(async () => {
    testPort = await findAvailablePort();
    testWorkspace = `${process.env.TMPDIR || '/tmp'}/hyperneo-sigint-test-${Date.now()}`;
  });

  afterAll(() => {
    // Clean up any remaining process
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  });

  test(
    'should shutdown gracefully on SIGINT after server is ready',
    async () => {
      const mainPath = path.join(__dirname, '../main.ts');

      // Spawn CLI server in test mode (uses prod server, no Vite needed)
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

      // Wait for server to be ready
      console.log(`[TEST] Waiting for server to start on port ${testPort}...`);
      const { stdout: startupStdout } = await waitForServerReady(serverProcess);
      console.log(`[TEST] Server is ready. Startup output:\n${startupStdout.slice(0, 500)}`);

      // Record the start time for measuring shutdown duration
      const shutdownStart = Date.now();

      // Send SIGINT (Ctrl+C)
      console.log(`[TEST] Sending SIGINT to server PID ${serverProcess.pid}...`);
      const killResult = serverProcess.kill('SIGINT');
      expect(killResult).toBe(true);

      // Wait for process to exit
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

      // Verify graceful shutdown
      expect(code).toBe(0);
      expect(shutdownDuration).toBeLessThan(10000); // Should complete within 10s
      // Note: The "Received SIGINT" message goes to stderr which may not be fully captured
      // Check for the cleanup steps which indicate successful shutdown
      expect(shutdownOutput).toContain('Stopping server');
      expect(shutdownOutput).toContain('Graceful shutdown complete');

      serverProcess = null; // Mark as cleaned up
    },
    { timeout: 60000 }
  );

  test(
    'should handle rapid consecutive SIGINT signals',
    async () => {
      const mainPath = path.join(__dirname, '../main.ts');

      // Spawn CLI server
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

      // Wait for server to be ready
      console.log(`[TEST] Waiting for server to start...`);
      await waitForServerReady(serverProcess);
      console.log(`[TEST] Server is ready.`);

      // Send first SIGINT
      console.log(`[TEST] Sending first SIGINT...`);
      serverProcess.kill('SIGINT');

      // Immediately send second SIGINT (should trigger force exit or be ignored if first already completed)
      console.log(`[TEST] Sending second SIGINT immediately...`);
      serverProcess.kill('SIGINT');

      // Wait for process to exit
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

      // Server should exit - either gracefully (0) or forced (1)
      // The exact behavior depends on timing
      expect(code === 0 || code === 1).toBe(true);

      serverProcess = null;
    },
    { timeout: 60000 }
  );
});

// If no credentials, add a placeholder test to show why tests were skipped
describe.skipIf(hasCredentials)('SIGINT Shutdown Integration (skipped)', () => {
  test('requires API credentials - set ANTHROPIC_API_KEY, GLM_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN', () => {
    console.log('Skipping SIGINT integration tests - no API credentials available');
    expect(true).toBe(true);
  });
});
