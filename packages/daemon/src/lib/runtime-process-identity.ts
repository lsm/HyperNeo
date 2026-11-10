export type ProcessIdentity = { seconds: number; microseconds: number };
let reader: Promise<(pid: number, data: Uint8Array) => number> | undefined;

async function nativeReader() {
  const ffi = await import('bun:ffi');
  const library = ffi.dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
  });
  return (pid: number, data: Uint8Array) =>
    library.symbols.proc_pidinfo(pid, 3, 0, ffi.ptr(data), data.byteLength);
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const data = new Uint8Array(136);
    const read = await (reader ??= nativeReader());
    if (read(pid, data) !== data.byteLength) return null;
    const view = new DataView(data.buffer);
    if (view.getUint32(12, true) !== pid || view.getUint32(20, true) !== process.getuid?.())
      return null;
    return {
      seconds: Number(view.getBigUint64(120, true)),
      microseconds: Number(view.getBigUint64(128, true)),
    };
  } catch {
    return null;
  }
}
