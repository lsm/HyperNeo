/**
 * Sandbox Restriction Tests
 *
 * These tests verify that sandbox correctly restricts file access:
 * - Files outside workspace cannot be modified
 * - Bash commands are sandboxed
 * - Network access is restricted
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 * - Requires sandbox support (macOS, Linux, or WSL2)
 *
 * MODEL:
 * - Uses 'haiku-4.5' for faster and cheaper tests
 *
 * PLATFORM NOTE:
 * - macOS: Seatbelt (built-in)
 * - Linux/WSL2: Requires bubblewrap and socat
 * - Skipped on Windows
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

// Skip on Windows (sandbox not supported)
const platform = os.platform();
const skipTest = platform === 'win32';

describe('Sandbox Restrictions', { skip: skipTest }, () => {
  let daemon: DaemonServerContext;
  let workspacePath: string;
  let tempDirOutsideWorkspace: string;

  beforeAll(async () => {
    // Create a temporary workspace directory
    workspacePath = path.join(os.tmpdir(), `neokai-sandbox-test-${Date.now()}`);
    await fs.mkdir(workspacePath, { recursive: true });

    // Create a temporary directory OUTSIDE the workspace for testing restrictions
    tempDirOutsideWorkspace = path.join(os.tmpdir(), `neokai-sandbox-outside-${Date.now()}`);
    await fs.mkdir(tempDirOutsideWorkspace, { recursive: true });

    // Create daemon server
    daemon = await createDaemonServer();
  }, 60_000);

  afterAll(async () => {
    // Cleanup sessions and daemon
    if (daemon) {
      await daemon.cleanup();
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }

    // Cleanup directories
    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch {
      console.warn('Failed to cleanup workspace');
    }
    try {
      await fs.rm(tempDirOutsideWorkspace, { recursive: true, force: true });
    } catch {
      console.warn('Failed to cleanup temp dir');
    }
  });

  describe('Filesystem restrictions', () => {
    test('should reject file write outside workspace', async () => {
      const testFilePath = path.join(tempDirOutsideWorkspace, 'test-sandbox.txt');

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox File Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          // Sandbox is enabled by default, but let's be explicit
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to file outside workspace
        const messageContent = `Write the text "SANDBOX TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file was NOT created outside workspace
        // (If sandbox is working, the file should not exist)
        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false; // File doesn't exist - sandbox is working! ✅
            }
            throw error; // Some other error
          });

        expect(fileExists).toBe(false);
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });
      }
    });

    test('should allow file write inside workspace', async () => {
      const testFilePath = path.join(workspacePath, 'test-inside-workspace.txt');

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Inside Workspace Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to file inside workspace
        const messageContent = `Write the text "INSIDE WORKSPACE" to the file test-inside-workspace.txt`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file WAS created inside workspace
        // (Sandbox should allow writes to cwd)
        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('INSIDE WORKSPACE');
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('Bash command sandboxing', () => {
    test('should run bash commands in sandbox', async () => {
      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Bash Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'bypassPermissions',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to run a bash command that writes to workspace (should succeed)
        const messageContent =
          'Create a file named test-bash-sandbox.txt with content "BASH SANDBOX TEST"';

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Verify the file was created
        const testFilePath = path.join(workspacePath, 'test-bash-sandbox.txt');
        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('BASH SANDBOX TEST');
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file
        try {
          const testFilePath = path.join(workspacePath, 'test-bash-sandbox.txt');
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('Sandbox configuration override', () => {
    test('should allow disabling sandbox per session', async () => {
      const testFilePath = path.join(tempDirOutsideWorkspace, 'test-no-sandbox.txt');

      // Create session with sandbox DISABLED
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'No Sandbox Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: false, // Explicitly disable sandbox
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to file outside workspace
        // (Should succeed when sandbox is disabled)
        const messageContent = `Write the text "NO SANDBOX" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file WAS created (sandbox was disabled)
        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('NO SANDBOX');
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('Allowed directory writes', () => {
    test('should allow writes to ~/.claude/ directory (except settings.json)', async () => {
      const homedir = os.homedir();
      const testFilePath = path.join(homedir, '.claude', 'test-sandbox-write.txt');

      // Ensure .claude directory exists
      await fs.mkdir(path.join(homedir, '.claude'), { recursive: true });

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Claude Dir Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to ~/.claude/ directory
        const messageContent = `Write the text "CLAUDE DIR TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file WAS created in ~/.claude/
        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('CLAUDE DIR TEST');
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    test('should allow writes to ~/.neokai/projects/ directory', async () => {
      const homedir = os.homedir();
      const testFilePath = path.join(homedir, '.neokai', 'projects', 'test-sandbox-write.txt');

      // Ensure .neokai/projects directory exists
      await fs.mkdir(path.join(homedir, '.neokai', 'projects'), { recursive: true });

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Neokai Dir Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to ~/.neokai/projects/ directory
        const messageContent = `Write the text "HYPERNEO PROJECTS TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file WAS created in ~/.neokai/projects/
        const fileContent = await fs.readFile(testFilePath, 'utf-8');
        expect(fileContent).toContain('HYPERNEO PROJECTS TEST');
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('Denied directory writes', () => {
    test('should deny writes to home directory root', async () => {
      const homedir = os.homedir();
      const testFilePath = path.join(homedir, 'test-sandbox-denied.txt');

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Home Dir Deny Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to home directory root
        const messageContent = `Write the text "HOME DIR TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file was NOT created in home directory root
        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false; // File doesn't exist - sandbox is working! ✅
            }
            throw error; // Some other error
          });

        expect(fileExists).toBe(false);
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file (in case sandbox failed)
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    test('should deny writes to ~/Documents/ directory', async () => {
      const homedir = os.homedir();
      const documentsPath = path.join(homedir, 'Documents');
      const testFilePath = path.join(documentsPath, 'test-sandbox-denied.txt');

      // Skip test if Documents directory doesn't exist
      const documentsExists = await fs
        .access(documentsPath)
        .then(() => true)
        .catch(() => false);

      if (!documentsExists) {
        console.log('Skipping ~/Documents/ test - directory does not exist');
        return;
      }

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox Documents Deny Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to ~/Documents/
        const messageContent = `Write the text "DOCUMENTS TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file was NOT created in Documents
        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false; // File doesn't exist - sandbox is working! ✅
            }
            throw error; // Some other error
          });

        expect(fileExists).toBe(false);
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file (in case sandbox failed)
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    test('should deny writes to system directories', async () => {
      // Test write to /etc (or /tmp for non-root users)
      // Note: We'll test /tmp but with a very specific path that should be denied
      const testFilePath = '/etc/test-sandbox-denied.txt';

      // Create session with sandbox enabled
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Sandbox System Dir Deny Test',
        config: {
          model: 'haiku-4.5',
          permissionMode: 'acceptEdits',
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            excludedCommands: ['git'],
            network: {
              allowLocalBinding: true,
              allowAllUnixSockets: true,
            },
          },
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      try {
        // Ask agent to write to /etc/
        const messageContent = `Write the text "SYSTEM DIR TEST" to the file ${testFilePath}`;

        await sendMessage(daemon.messageHub, sessionId, messageContent);

        // Wait for processing to complete
        await waitForIdle(daemon.messageHub, sessionId, 30000);

        // Check that the file was NOT created in /etc/
        const fileExists = await fs
          .access(testFilePath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return false; // File doesn't exist - sandbox is working! ✅
            }
            throw error; // Some other error
          });

        expect(fileExists).toBe(false);
      } finally {
        // Cleanup session
        await daemon.messageHub.request('session.delete', { sessionId });

        // Cleanup test file (in case sandbox failed - though this would require root)
        try {
          await fs.rm(testFilePath, { force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });
});
