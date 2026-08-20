import { ptr } from 'bun:ffi';
import type { AcpProcessTree, AcpProcessTreeOwner } from './acp-process-tree';

interface BunFfiModule {
  dlopen: (
    path: string,
    symbols: Record<string, { args: unknown[]; returns: unknown }>
  ) => { symbols: WindowsJobSymbols };
  FFIType: Record<string, unknown>;
}

interface WindowsJobSymbols {
  AssignProcessToJobObject: (job: bigint, process: bigint) => number;
  CloseHandle: (handle: bigint) => number;
  CreateJobObjectA: (attributes: null, name: null) => bigint;
  GetLastError: () => number;
  OpenProcess: (access: number, inheritHandle: number, pid: number) => bigint;
  SetInformationJobObject: (
    job: bigint,
    informationClass: number,
    information: unknown,
    informationLength: number
  ) => number;
  TerminateJobObject: (job: bigint, exitCode: number) => number;
}

const PROCESS_ASSIGN_TO_JOB = 0x101;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_BYTES = 144;
const JOB_OBJECT_LIMIT_FLAGS_OFFSET = 16;

function closeHandle(symbols: WindowsJobSymbols, handle: bigint): void {
  if (handle !== 0n) symbols.CloseHandle(handle);
}

async function createWindowsProcessTreeOwner(): Promise<AcpProcessTreeOwner> {
  const moduleName = ['bun', 'ffi'].join(':');
  const ffi = (await import(moduleName)) as unknown as BunFfiModule;
  const symbols = ffi.dlopen('kernel32.dll', {
    AssignProcessToJobObject: {
      args: [ffi.FFIType.u64, ffi.FFIType.u64],
      returns: ffi.FFIType.i32,
    },
    CloseHandle: { args: [ffi.FFIType.u64], returns: ffi.FFIType.i32 },
    CreateJobObjectA: {
      args: [ffi.FFIType.ptr, ffi.FFIType.ptr],
      returns: ffi.FFIType.u64,
    },
    GetLastError: { args: [], returns: ffi.FFIType.u32 },
    OpenProcess: {
      args: [ffi.FFIType.u32, ffi.FFIType.i32, ffi.FFIType.u32],
      returns: ffi.FFIType.u64,
    },
    SetInformationJobObject: {
      args: [ffi.FFIType.u64, ffi.FFIType.u32, ffi.FFIType.ptr, ffi.FFIType.u32],
      returns: ffi.FFIType.i32,
    },
    TerminateJobObject: {
      args: [ffi.FFIType.u64, ffi.FFIType.u32],
      returns: ffi.FFIType.i32,
    },
  }).symbols;

  return (child): AcpProcessTree => {
    const pid = child.pid;
    if (pid == null) throw new Error('Unable to own ACP process tree without a process id');
    const job = symbols.CreateJobObjectA(null, null);
    if (job === 0n) throw new Error(`Unable to create ACP process job (${symbols.GetLastError()})`);

    try {
      const limits = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_BYTES);
      limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_FLAGS_OFFSET);
      if (
        symbols.SetInformationJobObject(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
          ptr(limits),
          limits.length
        ) === 0
      ) {
        throw new Error(`Unable to configure ACP process job (${symbols.GetLastError()})`);
      }

      const processHandle = symbols.OpenProcess(PROCESS_ASSIGN_TO_JOB, 0, pid);
      if (processHandle === 0n) {
        throw new Error(`Unable to open ACP terminal process (${symbols.GetLastError()})`);
      }
      try {
        if (symbols.AssignProcessToJobObject(job, processHandle) === 0) {
          throw new Error(`Unable to assign ACP process job (${symbols.GetLastError()})`);
        }
      } finally {
        closeHandle(symbols, processHandle);
      }
    } catch (error) {
      closeHandle(symbols, job);
      child.kill('SIGKILL');
      throw error;
    }

    let closed = false;
    return {
      terminate: () => {
        if (closed) return;
        symbols.TerminateJobObject(job, 1);
        closeHandle(symbols, job);
        closed = true;
      },
    };
  };
}

export const windowsAcpProcessTreeOwner = await createWindowsProcessTreeOwner();
