import { randomUUID } from 'node:crypto';
import { constants, fstatSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_BUFFER_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x20 : 0x100;
const STAT_MODE_OFFSET = process.platform === 'darwin' ? 8 : process.arch === 'arm64' ? 16 : 24;
let darwinStatModeOffset: number | undefined;

interface BunFfiModule {
  toArrayBuffer: (pointer: unknown, offset: number, length: number) => ArrayBuffer;
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
  fchmod: (fd: number, mode: number) => number;
  fchmodat: (fd: number, path: Buffer, mode: number, flags: number) => number;
  fstatat: (fd: number, path: Buffer, stat: Buffer, flags: number) => number;
  mkdirat: (fd: number, path: Buffer, mode: number) => number;
  openat: (fd: number, path: Buffer, flags: number, mode: number) => number;
  read: (fd: number, buffer: Buffer, length: number) => number | bigint;
  renameat: (oldFd: number, oldPath: Buffer, newFd: number, newPath: Buffer) => number;
  unlinkat: (fd: number, path: Buffer, flags: number) => number;
  write: (fd: number, buffer: Buffer, length: number) => number | bigint;
}

interface SafeFsBackend {
  library: ReturnType<BunFfiModule['dlopen']>;
  atFdcwd: number;
  symbols: LibcSymbols;
  errno: () => number;
}

export interface SafeFsReadOptions {
  startLine: number;
  lineLimit: number | undefined;
  maxBytes: number;
}

export interface SafeFsBackendModule {
  replaceFileWithinWorkspace: typeof replaceFileWithinWorkspace;
  withArtifactDescriptor: typeof withArtifactDescriptor;
  withStoredArtifactDescriptor: typeof withStoredArtifactDescriptor;
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

function throwFsError(operation: string, path: string, backend?: SafeFsBackend): never {
  const errno = backend?.errno();
  const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0];
  throw Object.assign(
    new Error(`${code ? `${code}: ` : ''}Unable to ${operation} ACP filesystem path: ${path}`),
    { code, errno }
  );
}

export function isSafeFsSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
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

async function loadSafeFsBackend(allowDeno = false): Promise<SafeFsBackend> {
  const candidates = platformLibraryCandidates();
  if (candidates.length === 0) {
    throw new Error(`ACP safe filesystem operations are unavailable on ${process.platform}`);
  }

  try {
    const moduleName = ['bun', 'ffi'].join(':');
    const deno = Reflect.get(globalThis, 'Deno') as {
      dlopen: (
        path: string,
        definitions: Record<string, { parameters: unknown[]; result: unknown }>
      ) => { symbols: LibcSymbols };
      UnsafePointerView: new (
        pointer: unknown
      ) => { getArrayBuffer: (length: number, offset: number) => ArrayBuffer };
    };
    const ffi: BunFfiModule =
      allowDeno && deno
        ? {
            FFIType: {
              i32: 'i32',
              u32: 'u32',
              u64: 'u64',
              i64: 'i64',
              cstring: 'buffer',
              ptr: 'buffer',
            },
            dlopen: (path, definitions) =>
              deno.dlopen(
                path,
                Object.fromEntries(
                  Object.entries(definitions).map(([key, value]) => [
                    key,
                    {
                      parameters: value.args,
                      result: value.returns === 'buffer' ? 'pointer' : value.returns,
                    },
                  ])
                )
              ),
            toArrayBuffer: (pointer, offset, length) =>
              new deno.UnsafePointerView(pointer).getArrayBuffer(length, offset),
          }
        : ((await import(moduleName)) as unknown as BunFfiModule);
    const errnoSymbol = process.platform === 'darwin' ? '__error' : '__errno_location';
    const definitions = {
      [errnoSymbol]: { args: [], returns: ffi.FFIType.ptr },
      close: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
      fchmod: { args: [ffi.FFIType.i32, ffi.FFIType.u32], returns: ffi.FFIType.i32 },
      fchmodat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.u32, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
      fstatat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.ptr, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
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
        const library = ffi.dlopen(candidate, definitions);
        const { symbols } = library;
        return {
          library,
          atFdcwd: process.platform === 'darwin' ? -2 : -100,
          symbols,
          errno: () =>
            new DataView(
              ffi.toArrayBuffer(
                (symbols as unknown as Record<string, () => unknown>)[errnoSymbol](),
                0,
                4
              )
            ).getInt32(0, true),
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

let writerBackend: Promise<SafeFsBackend> | undefined;
function getWriterBackend() {
  writerBackend ??= loadSafeFsBackend(true);
  return writerBackend;
}

function validateSegments(segments: string[]): void {
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0') ||
        segment.includes('/')
    )
  ) {
    throwFsError('access', segments.join('/'));
  }
}

function openDirectory(symbols: LibcSymbols, parentFd: number, name: string, flags = 0): number {
  return symbols.openat(
    parentFd,
    cString(name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | flags,
    0
  );
}

function closeFile(symbols: LibcSymbols, fd: number): void {
  if (fd >= 0) symbols.close(fd);
}

function openRootDirectory(
  symbols: LibcSymbols,
  atFdcwd: number,
  workspaceRoot: string,
  flags = 0
): number {
  let directoryFd = openDirectory(symbols, atFdcwd, '/', flags);
  for (const component of workspaceRoot.split('/')) {
    if (!component) continue;
    if (directoryFd < 0) return -1;
    const nextFd = openDirectory(symbols, directoryFd, component, flags);
    closeFile(symbols, directoryFd);
    directoryFd = nextFd;
  }
  return directoryFd;
}

export function locateStatModeOffset(statBuf: Buffer, knownMode: number, fallback: number): number {
  for (let offset = 0; offset + 2 <= statBuf.length && offset < 32; offset += 2) {
    if (statBuf.readUInt16LE(offset) === knownMode) return offset;
  }
  return fallback;
}

function getDarwinStatModeOffset(symbols: LibcSymbols, directoryFd: number): number {
  if (darwinStatModeOffset !== undefined) return darwinStatModeOffset;
  const knownMode = fstatSync(directoryFd).mode & 0xffff;
  const statBuf = Buffer.alloc(256);
  symbols.fstatat(directoryFd, cString('.'), statBuf, AT_SYMLINK_NOFOLLOW);
  darwinStatModeOffset = locateStatModeOffset(statBuf, knownMode, STAT_MODE_OFFSET);
  return darwinStatModeOffset;
}

export function decodeStatMode(statBuf: Buffer, modeOffset: number, modeWidth: 2 | 4): number {
  const mode =
    modeWidth === 2 ? statBuf.readUInt16LE(modeOffset) : statBuf.readUInt32LE(modeOffset);
  return (mode & 0o170000) === 0o100000 ? mode & 0o777 : FILE_MODE;
}

function replacementMode(symbols: LibcSymbols, directoryFd: number, fileName: string): number {
  let fileFd = symbols.openat(
    directoryFd,
    cString(fileName),
    constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    0
  );
  if (fileFd < 0) {
    fileFd = symbols.openat(
      directoryFd,
      cString(fileName),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      0
    );
  }
  if (fileFd >= 0) {
    try {
      const stats = fstatSync(fileFd);
      return stats.isFile() ? stats.mode & 0o777 : FILE_MODE;
    } finally {
      closeFile(symbols, fileFd);
    }
  }

  const statBuf = Buffer.alloc(256);
  if (symbols.fstatat(directoryFd, cString(fileName), statBuf, AT_SYMLINK_NOFOLLOW) !== 0) {
    return FILE_MODE;
  }
  const modeOffset =
    process.platform === 'darwin'
      ? getDarwinStatModeOffset(symbols, directoryFd)
      : STAT_MODE_OFFSET;
  const modeWidth = process.platform === 'darwin' ? 2 : 4;
  return decodeStatMode(statBuf, modeOffset, modeWidth);
}

async function openWorkspacePath(
  workspace: string,
  segments: string[],
  createParents: boolean,
  backend?: SafeFsBackend
): Promise<{ symbols: LibcSymbols; directoryFd: number; fileName: string }> {
  validateSegments(segments);
  const { atFdcwd, symbols } = backend ?? (await getSafeFsBackend());
  let workspaceRoot = workspace;
  try {
    workspaceRoot = realpathSync(workspace);
  } catch {
    throwFsError('open', workspace);
  }
  let directoryFd = openRootDirectory(symbols, atFdcwd, workspaceRoot);
  if (directoryFd < 0) throwFsError('open', workspace, backend);

  try {
    for (const segment of segments.slice(0, -1)) {
      let nextFd = openDirectory(symbols, directoryFd, segment);
      if (nextFd < 0 && createParents) {
        const created = symbols.mkdirat(directoryFd, cString(segment), DIRECTORY_MODE) === 0;
        nextFd = openDirectory(symbols, directoryFd, segment);
        if (created && nextFd >= 0) {
          try {
            if (symbols.fchmod(nextFd, DIRECTORY_MODE) !== 0)
              throwFsError('chmod', segment, backend);
          } catch (error) {
            closeFile(symbols, nextFd);
            throw error;
          }
        } else if (created) {
          if (
            symbols.fchmodat(directoryFd, cString(segment), DIRECTORY_MODE, AT_SYMLINK_NOFOLLOW) ===
            0
          ) {
            nextFd = openDirectory(symbols, directoryFd, segment);
          }
        }
      }
      if (nextFd < 0) throwFsError('open', segment, backend);
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

  const endLine =
    options.lineLimit === undefined
      ? Number.POSITIVE_INFINITY
      : options.startLine + options.lineLimit;
  const chunks: Buffer[] = [];
  let scannedBytes = 0;
  let selectedBytes = 0;
  let line = 0;

  try {
    if (!fstatSync(fileFd).isFile()) throwFsError('read', fileName);
    while (line < endLine) {
      const remainingBytes = options.maxBytes - scannedBytes;
      if (remainingBytes <= 0) {
        const probe = Buffer.allocUnsafe(1);
        const probed = Number(symbols.read(fileFd, probe, 1));
        if (probed < 0) throwFsError('read', fileName);
        if (probed > 0) {
          throw new Error(`ACP filesystem scan exceeds ${options.maxBytes} bytes`);
        }
        break;
      }
      const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, remainingBytes));
      const bytesRead = Number(symbols.read(fileFd, buffer, buffer.length));
      if (bytesRead < 0) throwFsError('read', fileName);
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      const content = buffer.subarray(0, bytesRead);
      let cursor = 0;
      let selectionStart = -1;
      let selectionEnd = -1;

      for (let index = 0; index < content.length; index++) {
        if (content[index] !== 10) continue;
        if (line >= options.startLine && line < endLine) {
          if (selectionStart < 0) selectionStart = cursor;
          selectionEnd = index + 1;
        }
        line++;
        cursor = index + 1;
        if (line >= endLine) break;
      }

      if (line >= options.startLine && line < endLine && cursor < content.length) {
        if (selectionStart < 0) selectionStart = cursor;
        selectionEnd = content.length;
      }

      if (selectionStart >= 0) {
        const chunk = content.subarray(selectionStart, selectionEnd);
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
  return replaceWorkspaceFile(workspace, segments, data, await getSafeFsBackend(), signal);
}

export async function replaceFileWithinWorkspace(
  workspace: string,
  segments: string[],
  data: Uint8Array | null,
  signal?: AbortSignal
) {
  return replaceWorkspaceFile(
    workspace,
    segments,
    data === null ? null : Buffer.from(data),
    await getWriterBackend(),
    signal
  );
}

async function replaceWorkspaceFile(
  workspace: string,
  segments: string[],
  data: Buffer | null,
  backend: SafeFsBackend,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw new Error('ACP filesystem write cancelled');
  const { symbols, directoryFd, fileName } = await openWorkspacePath(
    workspace,
    segments,
    data !== null,
    backend
  );
  const temporaryName = `.acp-${randomUUID()}`;
  let temporaryExists = false;

  try {
    if (data === null) {
      if (symbols.unlinkat(directoryFd, cString(fileName), 0) !== 0)
        throwFsError('remove', fileName, backend);
      return;
    }
    const prior = process.versions.bun
      ? null
      : lstatSync(join(workspace, ...segments), { throwIfNoEntry: false });
    const mode = process.versions.bun
      ? replacementMode(symbols, directoryFd, fileName)
      : prior?.isFile()
        ? prior.mode & 0o777
        : FILE_MODE;
    if (signal?.aborted) throw new Error('ACP filesystem write cancelled');
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
    if (fileFd < 0) throwFsError('open', fileName, backend);
    temporaryExists = true;

    let closed = -1;
    try {
      let offset = 0;
      while (offset < data.length) {
        if (signal?.aborted) throw new Error('ACP filesystem write cancelled');
        const written = Number(symbols.write(fileFd, data.subarray(offset), data.length - offset));
        if (written <= 0) throwFsError('write', fileName, backend);
        offset += written;
      }
      if (symbols.fchmod(fileFd, mode) !== 0) throwFsError('chmod', fileName, backend);
    } finally {
      closed = symbols.close(fileFd);
    }
    if (closed !== 0) throwFsError('write', fileName, backend);

    if (signal?.aborted) throw new Error('ACP filesystem write cancelled');
    if (
      symbols.renameat(directoryFd, cString(temporaryName), directoryFd, cString(fileName)) !== 0
    ) {
      throwFsError('replace', fileName, backend);
    }
    temporaryExists = false;
  } finally {
    if (temporaryExists) symbols.unlinkat(directoryFd, cString(temporaryName), 0);
    closeFile(symbols, directoryFd);
  }
}

async function withRegularArtifactDescriptor<Value>(
  root: string,
  segments: string[],
  consume: (fd: number, initial: Stats) => Value | Promise<Value>,
  maxLinks: number
): Promise<
  | { accepted: true; value: Value }
  | { accepted: false; reason: 'safe_open_unavailable' | 'unsafe_path' }
> {
  const backend = await getSafeFsBackend().catch(() => null);
  if (!backend) return { accepted: false, reason: 'safe_open_unavailable' };
  try {
    validateSegments(segments);
    if (!root.startsWith('/') || root.includes('\0')) throw new Error('invalid_root');
    if (root !== '/') validateSegments(root.split('/').filter(Boolean));
  } catch {
    return { accepted: false, reason: 'unsafe_path' };
  }
  const { symbols, atFdcwd } = backend;
  const cloexec = process.platform === 'darwin' ? 0x1000000 : 0x80000;
  let directoryFd = -1;
  let fileFd = -1;
  try {
    directoryFd = openRootDirectory(symbols, atFdcwd, root, cloexec);
    if (directoryFd < 0) return { accepted: false, reason: 'unsafe_path' };
    for (const segment of segments.slice(0, -1)) {
      const nextFd = openDirectory(symbols, directoryFd, segment, cloexec);
      closeFile(symbols, directoryFd);
      directoryFd = nextFd;
      if (directoryFd < 0) return { accepted: false, reason: 'unsafe_path' };
    }
    fileFd = symbols.openat(
      directoryFd,
      cString(segments[segments.length - 1]),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | cloexec,
      0
    );
    if (fileFd < 0) return { accepted: false, reason: 'unsafe_path' };
    const initial = fstatSync(fileFd);
    if (!initial.isFile() || initial.nlink < 1 || initial.nlink > maxLinks)
      return { accepted: false, reason: 'unsafe_path' };
    return { accepted: true, value: await consume(fileFd, initial) };
  } finally {
    closeFile(symbols, fileFd);
    closeFile(symbols, directoryFd);
  }
}

export function withArtifactDescriptor<Value>(
  root: string,
  segments: string[],
  consume: (fd: number, initial: Stats) => Value | Promise<Value>
) {
  return withRegularArtifactDescriptor(root, segments, consume, 1);
}

export function withStoredArtifactDescriptor<Value>(
  root: string,
  sha256: string,
  consume: (fd: number, initial: Stats) => Value | Promise<Value>
) {
  return withRegularArtifactDescriptor(root, ['blobs', sha256], consume, 2);
}
