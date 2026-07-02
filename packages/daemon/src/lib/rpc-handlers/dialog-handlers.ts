/**
 * Dialog Handlers
 *
 * RPC handlers for native OS dialogs.
 * - dialog.pickFolder - Open native folder picker dialog
 */

import type { MessageHub } from '@hyperneo/shared';
import { Logger } from '../logger';

const log = new Logger('dialog-handlers');
const FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

interface DialogPickFolderRequest {
  timeoutMs?: number;
}

function normalizePickerTimeout(timeoutMs: unknown): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : FOLDER_PICKER_TIMEOUT_MS;
}

/**
 * Open a native folder picker dialog
 * Returns the selected folder path or null if cancelled
 */
async function pickFolder(timeoutMs = FOLDER_PICKER_TIMEOUT_MS): Promise<string | null> {
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      // macOS - use osascript with AppleScript
      // Use POSIX path to get the full filesystem path directly
      const result = await runCommand(
        'osascript',
        ['-e', `POSIX path of (choose folder with prompt "Select a workspace folder:")`],
        timeoutMs
      );
      return result?.trim() || null;
    } else if (platform === 'linux') {
      // Linux - try zenity first, then kdialog
      if (await commandExists('zenity')) {
        const result = await runCommand(
          'zenity',
          ['--file-selection', '--directory', '--title=Select a workspace folder'],
          timeoutMs
        );
        return result?.trim() || null;
      } else if (await commandExists('kdialog')) {
        const result = await runCommand(
          'kdialog',
          ['--getexistingdirectory', '/', 'Select a workspace folder'],
          timeoutMs
        );
        return result?.trim() || null;
      } else {
        log.warn('No dialog tool available on Linux (zenity or kdialog required)');
        return null;
      }
    } else if (platform === 'win32') {
      // Windows - use PowerShell with FolderBrowserDialog
      const psScript = `
				Add-Type -AssemblyName System.Windows.Forms
				$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
				$dialog.Description = "Select a workspace folder"
				$dialog.ShowNewFolderButton = $true
				if ($dialog.ShowDialog() -eq "OK") {
					$dialog.SelectedPath
				}
			`;
      const result = await runCommand('powershell', ['-Command', psScript], timeoutMs);
      return result?.trim() || null;
    } else {
      log.warn(`Unsupported platform for folder picker: ${platform}`);
      return null;
    }
  } catch (err) {
    log.error('Failed to open folder picker:', err);
    return null;
  }
}

/**
 * Run a command and return stdout
 */
async function runCommand(cmd: string, args: string[], timeoutMs?: number): Promise<string | null> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();

  // Read all stdout asynchronously
  const readStdout = async () => {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      if (value) stdoutChunks.push(value);
    }
  };

  // Read all stderr asynchronously
  const readStderr = async () => {
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      if (value) stderrChunks.push(value);
    }
  };

  const completion = Promise.all([readStdout(), readStderr(), proc.exited])
    .then(([, , exitCode]) => ({ status: 'exited' as const, exitCode }))
    .catch((error) => ({ status: 'error' as const, error }));

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    timeoutMs !== undefined
      ? new Promise<{ status: 'timeout' }>((resolve) => {
          timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
        })
      : null;

  const outcome = timeout ? await Promise.race([completion, timeout]) : await completion;
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  if (outcome.status === 'timeout') {
    log.warn(`Command '${cmd}' timed out after ${timeoutMs}ms; closing folder picker`);
    try {
      proc.kill();
      await proc.exited.catch(() => {});
    } catch (error) {
      log.debug(`Failed to kill timed-out command '${cmd}':`, error);
    }
    return null;
  }

  if (outcome.status === 'error') {
    log.debug(`Command '${cmd}' failed:`, outcome.error);
    return null;
  }

  const { exitCode } = outcome;

  // Combine all chunks
  const stdout =
    stdoutChunks.length > 0 ? new TextDecoder().decode(Buffer.concat(stdoutChunks)) : '';
  const stderr =
    stderrChunks.length > 0 ? new TextDecoder().decode(Buffer.concat(stderrChunks)) : '';

  if (exitCode === 0) {
    return stdout;
  } else {
    log.debug(`Command '${cmd}' exited with code ${exitCode}: ${stderr}`);
    return null;
  }
}

/**
 * Check if a command exists
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    const result = await runCommand('which', [cmd]);
    return result !== null && result.trim().length > 0;
  } catch {
    return false;
  }
}

export function setupDialogHandlers(messageHub: MessageHub): void {
  // dialog.pickFolder - Open native folder picker
  messageHub.onRequest('dialog.pickFolder', async (data: DialogPickFolderRequest | undefined) => {
    const path = await pickFolder(normalizePickerTimeout(data?.timeoutMs));
    return { path };
  });
}
