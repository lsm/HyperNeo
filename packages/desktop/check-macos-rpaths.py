#!/usr/bin/env python3
import ctypes
import os
from pathlib import Path
import re
import subprocess
import sys

SWIFT_CACHE = ctypes.CDLL(None)._dyld_shared_cache_contains_path
SWIFT_CACHE.argtypes = [ctypes.c_char_p]
SWIFT_CACHE.restype = ctypes.c_bool
LOAD_DYLIB = {
    "LC_LOAD_DYLIB",
    "LC_LOAD_WEAK_DYLIB",
    "LC_REEXPORT_DYLIB",
    "LC_LOAD_UPWARD_DYLIB",
    "LC_LAZY_LOAD_DYLIB",
}


def output(*args):
    return subprocess.check_output(args, text=True)


def expand_rpath(path, loader, executable):
    for token, directory in (("@loader_path", loader), ("@executable_path", executable)):
        if path == token or path.startswith(token + "/"):
            return directory / path[len(token):].lstrip("/")
    return Path(path)


def resolves(path):
    normalized = Path(os.path.normpath(path))
    if not normalized.is_absolute():
        return False
    return normalized.is_file() or (
        normalized.parent == Path("/usr/lib/swift")
        and SWIFT_CACHE(os.fsencode(normalized))
    )


def check(app):
    binaries = dependencies = failures = 0
    for binary in sorted(app.rglob("*")):
        if binary.is_symlink() or not binary.is_file():
            continue
        if not output("/usr/bin/file", "-b", str(binary)).startswith("Mach-O"):
            continue
        binaries += 1
        for arch in output("/usr/bin/lipo", "-archs", str(binary)).split():
            commands = output("/usr/bin/otool", "-arch", arch, "-l", str(binary))
            blocks = re.split(r"(?m)^Load command \d+\n", commands)[1:]
            rpaths = []
            loads = []
            for block in blocks:
                command = re.search(r"(?m)^\s*cmd (\S+)$", block).group(1)
                if command == "LC_RPATH":
                    rpaths.append(re.search(r"(?m)^\s*path (.*) \(offset \d+\)$", block).group(1))
                if command in LOAD_DYLIB:
                    loads.append(re.search(r"(?m)^\s*name (.*) \(offset \d+\)$", block).group(1))
            headers = output("/usr/bin/otool", "-arch", arch, "-hv", str(binary))
            enclosing_app = next(parent for parent in binary.parents if parent.suffix == ".app")
            executable = binary.parent if re.search(r"\bEXECUTE\b", headers) else enclosing_app / "Contents/MacOS"
            for load in loads:
                if not load.startswith("@rpath/"):
                    continue
                dependencies += 1
                suffix = load.removeprefix("@rpath/")
                if not any(resolves(expand_rpath(path, binary.parent, executable) / suffix) for path in rpaths):
                    failures += 1
                    print(f"{binary.relative_to(app)} [{arch}]: unresolved {load}, LC_RPATHs={rpaths}", file=sys.stderr)
    print(f"Checked {binaries} Mach-O files, {dependencies} @rpath dependencies, {failures} unresolved")
    return 1 if failures or not binaries else 0


if __name__ == "__main__":
    sys.exit(check(Path(sys.argv[1]).resolve(strict=True)))
