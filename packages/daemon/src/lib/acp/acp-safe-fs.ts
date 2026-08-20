import { constants } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';

const AT_FDCWD = -2;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  mkdirat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.u32],
    returns: FFIType.i32,
  },
  openat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32],
    returns: FFIType.i32,
  },
  write: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
});

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function openDirectory(parentFd: number, name: string): number {
  return libc.symbols.openat(
    parentFd,
    cString(name),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    0
  );
}

function closeFile(fd: number): void {
  if (fd >= 0) libc.symbols.close(fd);
}

function throwFsError(operation: string, path: string): never {
  throw new Error(`Unable to ${operation} ACP filesystem path: ${path}`);
}

export async function writeFileWithinWorkspace(
  workspace: string,
  segments: string[],
  content: string,
  signal: AbortSignal
): Promise<void> {
  let directoryFd = openDirectory(AT_FDCWD, workspace);
  if (directoryFd < 0) throwFsError('open', workspace);

  try {
    for (const segment of segments.slice(0, -1)) {
      if (signal.aborted) throw new Error('ACP filesystem write cancelled');
      let nextFd = openDirectory(directoryFd, segment);
      if (nextFd < 0) {
        libc.symbols.mkdirat(directoryFd, cString(segment), DIRECTORY_MODE);
        nextFd = openDirectory(directoryFd, segment);
      }
      if (nextFd < 0) throwFsError('open', segment);
      closeFile(directoryFd);
      directoryFd = nextFd;
    }

    if (signal.aborted) throw new Error('ACP filesystem write cancelled');
    const fileName = segments.at(-1);
    if (!fileName) throwFsError('write', workspace);
    const fileFd = libc.symbols.openat(
      directoryFd,
      cString(fileName),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      FILE_MODE
    );
    if (fileFd < 0) throwFsError('open', fileName);

    try {
      if (libc.symbols.ftruncate(fileFd, 0) !== 0) throwFsError('truncate', fileName);
      const data = Buffer.from(content);
      let offset = 0;
      while (offset < data.length) {
        if (signal.aborted) throw new Error('ACP filesystem write cancelled');
        const written = Number(
          libc.symbols.write(fileFd, data.subarray(offset), data.length - offset)
        );
        if (written <= 0) throwFsError('write', fileName);
        offset += written;
      }
    } finally {
      closeFile(fileFd);
    }
  } finally {
    closeFile(directoryFd);
  }
}
