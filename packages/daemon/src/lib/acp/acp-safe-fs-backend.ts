import { randomUUID } from 'node:crypto';
import { constants, fchmodSync, fstatSync } from 'node:fs';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;

interface BunFfiModule {
  dlopen: (
    path: string,
    symbols: Record<
      string,
      {
        args: unknown[];
        returns: unknown;
      }
    >
  ) => {
    symbols: LibcSymbols;
  };
  FFIType: Record<string, unknown>;
}

interface LibcSymbols {
  close: (fd: number) => number;
  mkdirat: (fd: number, path: Buffer, mode: number) => number;
  openat: (fd: number, path: Buffer, flags: number, mode: number) => number;
  read: (fd: number, buffer: Buffer, length: number) => number | bigint;
  renameat: (oldFd: number, oldPath: Buffer, newFd: number, newPath: Buffer) => number;
  unlinkat: (fd: number, path: Buffer, flags: number) => number;
  write: (fd: number, buffer: Buffer, length: number) => number | bigint;
}

interface SafeFsBackend {
  atFdcwd: number;
  symbols: LibcSymbols;
}

export interface SafeFsReadOptions {
  startLine: number;
  lineLimit: number | undefined;
  maxBytes: number;
}

export interface SafeFsBackendModule {
  readFileWithinWorkspace: (
    workspace: string,
    segments: string[],
    options: SafeFsReadOptions
  ) => Promise<string>;
  writeFileWithinWorkspace: (
    workspace: string,
    segments: string[],
    content: string,
    signal: AbortSignal
  ) => Promise<void>;
}

let backendPromise: Promise<SafeFsBackend> | undefined;

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function throwFsError(operation: string, path: string): never {
  throw new Error(`Unable to ${operation} ACP filesystem path: ${path}`);
}

function platformLibraryCandidates(): string[] {
  if (process.platform === 'darwin') return ['/usr/lib/libSystem.B.dylib'];
  if (process.platform !== 'linux') return [];
  const muslArch =
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  return [
    'libc.so.6',
    `libc.musl-${muslArch}.so.1`,
    `/lib/libc.musl-${muslArch}.so.1`,
    `/usr/lib/libc.musl-${muslArch}.so.1`,
    `/lib/ld-musl-${muslArch}.so.1`,
  ];
}

async function loadSafeFsBackend(): Promise<SafeFsBackend> {
  const candidates = platformLibraryCandidates();
  if (candidates.length === 0) {
    throw new Error(`ACP safe filesystem operations are unavailable on ${process.platform}`);
  }

  try {
    const moduleName = ['bun', 'ffi'].join(':');
    const ffi = (await import(moduleName)) as unknown as BunFfiModule;
    const definitions = {
      close: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
      mkdirat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.u32],
        returns: ffi.FFIType.i32,
      },
      openat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.u32],
        returns: ffi.FFIType.i32,
      },
      read: {
        args: [ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.u64],
        returns: ffi.FFIType.i64,
      },
      renameat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.cstring],
        returns: ffi.FFIType.i32,
      },
      unlinkat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
      write: {
        args: [ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.u64],
        returns: ffi.FFIType.i64,
      },
    };

    for (const candidate of candidates) {
      try {
        return {
          atFdcwd: process.platform === 'darwin' ? -2 : -100,
          symbols: ffi.dlopen(candidate, definitions).symbols,
        };
      } catch {}
    }
  } catch {}

  throw new Error(`ACP safe filesystem operations are unavailable on ${process.platform}`);
}

function getSafeFsBackend(): Promise<SafeFsBackend> {
  backendPromise ??= loadSafeFsBackend();
  return backendPromise;
}

function validateSegments(segments: string[]): void {
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0')
    )
  ) {
    throwFsError('access', segments.join('/'));
  }
}

function openDirectory(symbols: LibcSymbols, parentFd: number, name: string): number {
  return symbols.openat(
    parentFd,
    cString(name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0
  );
}

function closeFile(symbols: LibcSymbols, fd: number): void {
  if (fd >= 0) symbols.close(fd);
}

function replacementMode(symbols: LibcSymbols, directoryFd: number, fileName: string): number {
  const fileFd = symbols.openat(
    directoryFd,
    cString(fileName),
    constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    0
  );
  if (fileFd < 0) return FILE_MODE;

  try {
    const stats = fstatSync(fileFd);
    return stats.isFile() ? stats.mode & 0o777 : FILE_MODE;
  } finally {
    closeFile(symbols, fileFd);
  }
}

async function openWorkspacePath(
  workspace: string,
  segments: string[],
  createParents: boolean
): Promise<{ symbols: LibcSymbols; directoryFd: number; fileName: string }> {
  validateSegments(segments);
  const { atFdcwd, symbols } = await getSafeFsBackend();
  let directoryFd = openDirectory(symbols, atFdcwd, workspace);
  if (directoryFd < 0) throwFsError('open', workspace);

  try {
    for (const segment of segments.slice(0, -1)) {
      let nextFd = openDirectory(symbols, directoryFd, segment);
      if (nextFd < 0 && createParents) {
        symbols.mkdirat(directoryFd, cString(segment), DIRECTORY_MODE);
        nextFd = openDirectory(symbols, directoryFd, segment);
      }
      if (nextFd < 0) throwFsError('open', segment);
      closeFile(symbols, directoryFd);
      directoryFd = nextFd;
    }

    const fileName = segments.at(-1);
    if (!fileName) throwFsError('access', workspace);
    return { symbols, directoryFd, fileName };
  } catch (error) {
    closeFile(symbols, directoryFd);
    throw error;
  }
}

export async function readFileWithinWorkspace(
  workspace: string,
  segments: string[],
  options: SafeFsReadOptions
): Promise<string> {
  if (options.lineLimit === 0) return '';
  const { symbols, directoryFd, fileName } = await openWorkspacePath(workspace, segments, false);
  const fileFd = symbols.openat(
    directoryFd,
    cString(fileName),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    0
  );
  closeFile(symbols, directoryFd);
  if (fileFd < 0) throwFsError('open', fileName);
  if (!fstatSync(fileFd).isFile()) {
    closeFile(symbols, fileFd);
    throwFsError('read', fileName);
  }

  const endLine =
    options.lineLimit === undefined
      ? Number.POSITIVE_INFINITY
      : options.startLine + options.lineLimit;
  const chunks: Buffer[] = [];
  let scannedBytes = 0;
  let selectedBytes = 0;
  let line = 0;

  try {
    while (line < endLine) {
      const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
      const bytesRead = Number(symbols.read(fileFd, buffer, buffer.length));
      if (bytesRead < 0) throwFsError('read', fileName);
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      if (scannedBytes > options.maxBytes) {
        throw new Error(`ACP filesystem scan exceeds ${options.maxBytes} bytes`);
      }
      const content = buffer.subarray(0, bytesRead);
      let cursor = 0;

      for (let index = 0; index < content.length; index++) {
        if (content[index] !== 10) continue;
        if (line >= options.startLine && line < endLine) {
          const chunk = content.subarray(cursor, index + 1);
          selectedBytes += chunk.length;
          if (selectedBytes > options.maxBytes) {
            throw new Error(`ACP filesystem read exceeds ${options.maxBytes} bytes`);
          }
          chunks.push(Buffer.from(chunk));
        }
        line++;
        cursor = index + 1;
        if (line >= endLine) break;
      }

      if (line >= options.startLine && line < endLine && cursor < content.length) {
        const chunk = content.subarray(cursor);
        selectedBytes += chunk.length;
        if (selectedBytes > options.maxBytes) {
          throw new Error(`ACP filesystem read exceeds ${options.maxBytes} bytes`);
        }
        chunks.push(Buffer.from(chunk));
      }
    }

    return Buffer.concat(chunks, selectedBytes).toString('utf-8');
  } finally {
    closeFile(symbols, fileFd);
  }
}

export async function writeFileWithinWorkspace(
  workspace: string,
  segments: string[],
  content: string,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw new Error('ACP filesystem write cancelled');
  if (content.length > MAX_WRITE_BYTES) {
    throw new Error(`ACP filesystem write exceeds ${MAX_WRITE_BYTES} bytes`);
  }
  const data = Buffer.from(content);
  if (data.length > MAX_WRITE_BYTES) {
    throw new Error(`ACP filesystem write exceeds ${MAX_WRITE_BYTES} bytes`);
  }
  const { symbols, directoryFd, fileName } = await openWorkspacePath(workspace, segments, true);
  const mode = replacementMode(symbols, directoryFd, fileName);
  const temporaryName = `.acp-${randomUUID()}`;
  let temporaryExists = false;

  try {
    if (signal.aborted) throw new Error('ACP filesystem write cancelled');
    const fileFd = symbols.openat(
      directoryFd,
      cString(temporaryName),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
      FILE_MODE
    );
    if (fileFd < 0) throwFsError('open', fileName);
    temporaryExists = true;

    try {
      if (!fstatSync(fileFd).isFile()) throwFsError('write', fileName);
      if (mode !== FILE_MODE) fchmodSync(fileFd, mode);
      let offset = 0;
      while (offset < data.length) {
        if (signal.aborted) throw new Error('ACP filesystem write cancelled');
        const written = Number(symbols.write(fileFd, data.subarray(offset), data.length - offset));
        if (written <= 0) throwFsError('write', fileName);
        offset += written;
      }
    } finally {
      closeFile(symbols, fileFd);
    }

    if (signal.aborted) throw new Error('ACP filesystem write cancelled');
    if (
      symbols.renameat(directoryFd, cString(temporaryName), directoryFd, cString(fileName)) !== 0
    ) {
      throwFsError('replace', fileName);
    }
    temporaryExists = false;
  } finally {
    if (temporaryExists) symbols.unlinkat(directoryFd, cString(temporaryName), 0);
    closeFile(symbols, directoryFd);
  }
}
